require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Partials, MessageFlags } = require('discord.js');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ----------------- Logging Setup -----------------
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFile = path.join(LOG_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${level}] ${args.join(' ')}`;
  console.log(message);
  logStream.write(message + '\n');
}

const logger = {
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
  debug: (...args) => process.env.NODE_ENV === 'development' && log('DEBUG', ...args),
};

// ----------------- Redis Setup -----------------
const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    logger.warn(`Redis connection retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => logger.error('Redis error:', err));
redis.on('connect', () => logger.info('Redis connected'));

// ----------------- Constants -----------------
const CARD_PULL_DEFAULT_HOURS = 11.5;
const TIMER_CHECK_INTERVAL = 10000; // Check every 10 seconds
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000; // 5 seconds between retries

const REGEX = {
  cooldown: /(?:you can rescue another animal in \*\*(.*?)\*\*|\(finishes in\s*([0-9:]+)\))/i,
  pullWait: /please wait\s+(.+?)\s+before pulling again/i,
  cardPull: /Next Card Pull:\s*\*\*(.*?)\*\*(?:\s*\(<t:(\d+)(?::[A-Za-z])?\)\))?/i,
  nextRescue: /Next Rescue:\s*\*\*(.*?)\*\*(?:\s*\(<t:(\d+)(?::[A-Za-z])?\)\))?/i,
};

const MESSAGES = {
  rescueReady: '🐾 Your rescue is ready!',
  cardPullReady: '🎴 Next Card Pull is ready!',
  rescueSet: (time) => `🐾 Next Rescue timer set for ${time}`,
  cardPullSet: (time) => `🎴 Next Card Pull timer set for ${time}`,
  dmOnly: '⚠️ This command only works in DMs! Please send me a direct message to use timer features.',
  noTimersSet: '💡 **Tip:** Run `/rescue`, `/terminal command:pul`, or `/terminal command:todo` to start tracking your timers!',
};

// ----------------- Redis Helper Functions -----------------
async function setTimerInRedis(channelId, timerType, targetTime) {
  const key = `timer:${channelId}:${timerType}`;
  const timerData = {
    targetTime: targetTime,
    setAt: Date.now(),
    channelId: channelId,
    timerType: timerType
  };
  
  // Store as JSON for full context
  await redis.set(key, JSON.stringify(timerData));
  
  // Use targetTime as score in sorted set for efficient range queries
  await redis.zadd('timers:queue', targetTime, `${channelId}:${timerType}`);
  
  const timeUntil = formatRemaining(targetTime - Date.now());
  logger.info(`Set ${timerType} timer for channel ${channelId} - fires at ${new Date(targetTime).toISOString()} (in ${timeUntil})`);
}

async function getTimerFromRedis(channelId, timerType) {
  const key = `timer:${channelId}:${timerType}`;
  const value = await redis.get(key);
  
  if (!value) return null;
  
  try {
    const data = JSON.parse(value);
    return data.targetTime;
  } catch (err) {
    // Fallback for old format (plain timestamp)
    return parseInt(value);
  }
}

async function getTimerDataFromRedis(channelId, timerType) {
  const key = `timer:${channelId}:${timerType}`;
  const value = await redis.get(key);
  
  if (!value) return null;
  
  try {
    return JSON.parse(value);
  } catch (err) {
    // Fallback for old format
    return {
      targetTime: parseInt(value),
      setAt: null,
      channelId,
      timerType
    };
  }
}

async function clearTimerFromRedis(channelId, timerType) {
  const key = `timer:${channelId}:${timerType}`;
  await redis.del(key);
  await redis.zrem('timers:queue', `${channelId}:${timerType}`);
  logger.info(`Cleared ${timerType} timer for channel ${channelId}`);
}

async function getRetryCount(channelId, timerType) {
  const key = `retry:${channelId}:${timerType}`;
  const count = await redis.get(key);
  return count ? parseInt(count) : 0;
}

async function incrementRetryCount(channelId, timerType) {
  const key = `retry:${channelId}:${timerType}`;
  await redis.incr(key);
  await redis.expire(key, 3600); // Expire after 1 hour
}

async function clearRetryCount(channelId, timerType) {
  const key = `retry:${channelId}:${timerType}`;
  await redis.del(key);
}

// ----------------- Utility Functions -----------------
function parseCooldown(cooldownStr) {
  cooldownStr = (cooldownStr || '').replace(/\*/g, '').trim();
  const parts = cooldownStr.split(':').map(Number).reverse();
  let ms = 0;

  if (parts.length >= 1 && Number.isFinite(parts[0])) ms += parts[0] * 1000;
  if (parts.length >= 2 && Number.isFinite(parts[1])) ms += parts[1] * 60 * 1000;
  if (parts.length >= 3 && Number.isFinite(parts[2])) ms += parts[2] * 60 * 60 * 1000;

  return ms;
}

function formatRemaining(ms) {
  if (!ms || ms <= 0) return '0s';

  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);

  return `${hrs > 0 ? hrs + 'h ' : ''}${mins > 0 ? mins + 'm ' : ''}${secs}s`;
}

function parseHumanDuration(text) {
  if (!text) return 0;

  text = text.toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let match;
  let ms = 0;

  while ((match = re.exec(text)) !== null) {
    const val = parseFloat(match[1]);
    const unit = match[2];

    if (/^h/.test(unit)) ms += Math.round(val * 60 * 60 * 1000);
    else if (/^m/.test(unit)) ms += Math.round(val * 60 * 1000);
    else if (/^s/.test(unit)) ms += Math.round(val * 1000);
  }

  if (ms === 0) {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) ms = Math.round(n * 60 * 1000);
  }

  return ms;
}

function absoluteFromParts(timeStr, ts) {
  if (ts) return Number(ts) * 1000;
  if (/now/i.test(timeStr)) return Date.now();
  return Date.now() + parseCooldown(timeStr);
}

function formatTimerStatus(nextTime) {
  if (!nextTime) return 'No active timer';
  const remaining = nextTime - Date.now();
  return remaining <= 0 ? 'Ready now!' : formatRemaining(remaining);
}

// ----------------- Timer Management -----------------
async function setTimer(channelId, timerType, targetTime, channel, notify = false) {
  const isRescue = timerType === 'rescue';
  const readyMsg = isRescue ? MESSAGES.rescueReady : MESSAGES.cardPullReady;
  const setMsg = isRescue ? MESSAGES.rescueSet : MESSAGES.cardPullSet;

  await setTimerInRedis(channelId, timerType, targetTime);
  
  const delay = targetTime - Date.now();

  if (delay <= 0) {
    await sendMessage(channel, readyMsg, channelId, timerType);
    await clearTimerFromRedis(channelId, timerType);
    return;
  }

  if (notify) {
    await sendMessage(channel, setMsg(formatRemaining(delay)), channelId, timerType);
  }
}

async function sendMessage(channel, message, channelId, timerType) {
  try {
    await channel.send(message);
    await clearRetryCount(channelId, timerType);
    logger.info(`Sent message to channel ${channelId}: ${message}`);
    return true;
  } catch (err) {
    logger.error(`Failed to send message to channel ${channelId}:`, err.message);
    const retryCount = await getRetryCount(channelId, timerType);
    
    if (retryCount < MAX_RETRY_ATTEMPTS) {
      await incrementRetryCount(channelId, timerType);
      logger.warn(`Queuing retry ${retryCount + 1}/${MAX_RETRY_ATTEMPTS} for channel ${channelId}`);
      
      // Schedule retry
      setTimeout(async () => {
        await sendMessage(channel, message, channelId, timerType);
      }, RETRY_DELAY);
    } else {
      logger.error(`Max retries reached for channel ${channelId}, clearing timer`);
      await clearTimerFromRedis(channelId, timerType);
      await clearRetryCount(channelId, timerType);
    }
    return false;
  }
}

async function setRescueTimer(channelId, rescueTimeMs, channel, notify = false) {
  await setTimer(channelId, 'rescue', rescueTimeMs, channel, notify);
}

async function setCardPullTimer(channelId, pullTimeMs, channel, notify = false) {
  await setTimer(channelId, 'cardPull', pullTimeMs, channel, notify);
}

// ----------------- Timer Checker -----------------
async function checkTimers() {
  try {
    const now = Date.now();
    
    // Get all timers that should have fired by now (score <= now)
    const dueTimers = await redis.zrangebyscore('timers:queue', 0, now);

    if (dueTimers.length > 0) {
      logger.info(`Found ${dueTimers.length} due timer(s) to process`);
    }

    for (const timerKey of dueTimers) {
      const [channelId, timerType] = timerKey.split(':');
      const timerData = await getTimerDataFromRedis(channelId, timerType);
      
      if (!timerData || !timerData.targetTime) {
        logger.warn(`Timer data missing for ${timerKey}, cleaning up`);
        await clearTimerFromRedis(channelId, timerType);
        continue;
      }

      const { targetTime, setAt } = timerData;
      
      // Double-check the timestamp (belt and suspenders approach)
      if (targetTime > now) {
        logger.warn(`Timer ${timerKey} not yet due (target: ${new Date(targetTime).toISOString()}), skipping`);
        continue;
      }

      const delay = now - targetTime;
      const delayStr = formatRemaining(delay);
      
      if (delay > 60000) { // More than 1 minute late
        logger.warn(`Timer ${timerKey} is ${delayStr} overdue (was set to fire at ${new Date(targetTime).toISOString()})`);
      } else {
        logger.info(`Processing timer ${timerKey} (on time)`);
      }

      try {
        const channel = await client.channels.fetch(channelId);
        const message = timerType === 'rescue' ? MESSAGES.rescueReady : MESSAGES.cardPullReady;
        
        const sent = await sendMessage(channel, message, channelId, timerType);
        if (sent) {
          await clearTimerFromRedis(channelId, timerType);
        }
      } catch (err) {
        logger.error(`Error processing timer for channel ${channelId}:`, err.message);
        
        // If channel doesn't exist anymore, clean up
        if (err.code === 10003 || err.message.includes('Unknown Channel')) {
          logger.warn(`Channel ${channelId} no longer exists, cleaning up timer`);
          await clearTimerFromRedis(channelId, timerType);
        }
      }
    }
  } catch (err) {
    logger.error('Error checking timers:', err);
  }
}

// Check for missed timers on startup
async function checkMissedTimers() {
  logger.info('Checking for missed timers from downtime...');
  await checkTimers();
}

// ----------------- Message Handlers -----------------
function handleManualCardPullReset(msg, channelId) {
  const content = msg.content.trim();
  if (content === '`$ pul`' || content === '`$ pull`') {
    const ms = Math.round(CARD_PULL_DEFAULT_HOURS * 60 * 60 * 1000);
    const pullTimeMs = Date.now() + ms;
    setCardPullTimer(channelId, pullTimeMs, msg.channel);
    return true;
  }
  return false;
}

function handlePullWaitMessage(msg, channelId) {
  const match = msg.content.match(REGEX.pullWait);
  if (match) {
    const ms = parseHumanDuration(match[1]);
    if (ms > 0) {
      const pullTimeMs = Date.now() + ms;
      setCardPullTimer(channelId, pullTimeMs, msg.channel);
      return true;
    }
  }
  return false;
}

function handleCooldownMessage(msg, channelId) {
  const match = msg.content.match(REGEX.cooldown);
  if (match) {
    const cooldownStr = match[1] ?? match[2];
    const rescueTimeMs = absoluteFromParts(cooldownStr, null);
    setRescueTimer(channelId, rescueTimeMs, msg.channel);
    return true;
  }
  return false;
}

function handleCardPullMessage(msg, channelId) {
  const match = msg.content.match(REGEX.cardPull);
  if (match) {
    const timeStr = match[1];
    const ts = match[2];
    const pullTimeMs = absoluteFromParts(timeStr, ts);
    const fromTd = msg.content.includes('$ td') || msg.content.includes('$ todo');
    setCardPullTimer(channelId, pullTimeMs, msg.channel, fromTd);
    return true;
  }
  return false;
}

function handleNextRescueMessage(msg, channelId) {
  const match = msg.content.match(REGEX.nextRescue);
  if (match) {
    const timeStr = match[1];
    const ts = match[2];
    const rescueTimeMs = absoluteFromParts(timeStr, ts);
    const fromTd = msg.content.includes('$ td') || msg.content.includes('$ todo');
    setRescueTimer(channelId, rescueTimeMs, msg.channel, fromTd);
    return true;
  }
  return false;
}

async function handleTimerCommand(msg, channelId) {
  if (msg.content.trim().toLowerCase() === '!timer') {
    const rescueTime = await getTimerFromRedis(channelId, 'rescue');
    const cardPullTime = await getTimerFromRedis(channelId, 'cardPull');
    const hasNoTimers = !rescueTime && !cardPullTime;

    const response = [
      `🐾 Next Rescue: ${formatTimerStatus(rescueTime)}`,
      `🎴 Next Card Pull: ${formatTimerStatus(cardPullTime)}`,
      hasNoTimers ? `\n${MESSAGES.noTimersSet}` : '',
    ].filter(Boolean).join('\n');

    msg.channel.send(response);
    return true;
  }
  return false;
}

// ----------------- Bot Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ----------------- Slash Commands Setup -----------------
const commands = [
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Show the remaining time until your next rescue and card pull'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    logger.info('Deploying slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    logger.info('Slash commands deployed!');
  } catch (err) {
    logger.error('Error deploying commands:', err);
  }
})();

// ----------------- Event Listeners -----------------
client.once('clientReady', () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info('Bot is ready to receive DMs!');
  
  // Check for any timers that should have fired while bot was down
  checkMissedTimers();
  
  // Start timer checker
  setInterval(checkTimers, TIMER_CHECK_INTERVAL);
  logger.info(`Timer checker started (interval: ${TIMER_CHECK_INTERVAL}ms)`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.id === client.user.id) return;

  const channelId = msg.channel.id;
  logger.debug(`Message from ${msg.author.tag} in channel ${channelId}`);

  try {
    handleManualCardPullReset(msg, channelId) ||
      handlePullWaitMessage(msg, channelId) ||
      handleCooldownMessage(msg, channelId) ||
      (handleCardPullMessage(msg, channelId) &&
      handleNextRescueMessage(msg, channelId)) ||
      await handleTimerCommand(msg, channelId);
  } catch (err) {
    logger.error('Error handling message:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'timer') {
    if (interaction.guild || !interaction.channel) {
      await interaction.reply({
        content: MESSAGES.dmOnly,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const channelId = interaction.channel.id;
    const rescueTime = await getTimerFromRedis(channelId, 'rescue');
    const cardPullTime = await getTimerFromRedis(channelId, 'cardPull');
    const hasNoTimers = !rescueTime && !cardPullTime;

    const response = [
      `🐾 Next Rescue: ${formatTimerStatus(rescueTime)}`,
      `🎴 Next Card Pull: ${formatTimerStatus(cardPullTime)}`,
      hasNoTimers ? `\n${MESSAGES.noTimersSet}` : '',
    ].filter(Boolean).join('\n');

    await interaction.reply(response);
  }
});

client.login(TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  await redis.quit();
  logStream.end();
  client.destroy();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});