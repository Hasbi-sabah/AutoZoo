require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Partials, MessageFlags } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// ----------------- Constants -----------------
const CARD_PULL_DEFAULT_HOURS = 11.5;
const RESCUE_DEFAULT_HOURS = 6;

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

// ----------------- State Management -----------------
const channelTimers = new Map();

function getChannelTimers(channelId) {
  if (!channelTimers.has(channelId)) {
    channelTimers.set(channelId, {
      rescueTimer: null,
      nextRescueTime: null,
      cardPullTimer: null,
      nextCardPullTime: null,
    });
  }
  return channelTimers.get(channelId);
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

  // Fallback: treat plain numbers as minutes
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

function formatTimerStatus(nextTime, includeHint = false) {
  if (!nextTime) {
    return includeHint ? 'No active timer' : 'No active timer';
  }

  const remaining = nextTime - Date.now();
  return remaining <= 0 ? 'Ready now!' : formatRemaining(remaining);
}

// ----------------- Timer Management -----------------
function setTimer(channelId, timerType, targetTime, channel, notify = false) {
  const timers = getChannelTimers(channelId);
  const isRescue = timerType === 'rescue';
  const timerKey = isRescue ? 'rescueTimer' : 'cardPullTimer';
  const timeKey = isRescue ? 'nextRescueTime' : 'nextCardPullTime';
  const readyMsg = isRescue ? MESSAGES.rescueReady : MESSAGES.cardPullReady;
  const setMsg = isRescue ? MESSAGES.rescueSet : MESSAGES.cardPullSet;

  // Clear existing timer
  if (timers[timerKey]) {
    clearTimeout(timers[timerKey]);
    timers[timerKey] = null;
  }

  timers[timeKey] = targetTime;
  const delay = targetTime - Date.now();

  if (delay <= 0) {
    channel.send(readyMsg);
    timers[timeKey] = null;
    return;
  }

  timers[timerKey] = setTimeout(() => {
    channel.send(readyMsg);
    timers[timerKey] = null;
    timers[timeKey] = null;
  }, delay);

  console.log(new Date().toISOString(), `${timerType} reminder for channel ${channelId} scheduled in ${Math.round(delay / 1000)}s`);

  if (notify) {
    channel.send(setMsg(formatRemaining(delay)));
  }
}

function setRescueTimer(channelId, rescueTimeMs, channel, notify = false) {
  setTimer(channelId, 'rescue', rescueTimeMs, channel, notify);
}

function setCardPullTimer(channelId, pullTimeMs, channel, notify = false) {
  setTimer(channelId, 'cardPull', pullTimeMs, channel, notify);
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

function handleTimerCommand(msg, channelId) {
  if (msg.content.trim().toLowerCase() === '!timer') {
    const timers = getChannelTimers(channelId);
    const hasNoTimers = !timers.nextRescueTime && !timers.nextCardPullTime;

    const response = [
      `🐾 Next Rescue: ${formatTimerStatus(timers.nextRescueTime)}`,
      `🎴 Next Card Pull: ${formatTimerStatus(timers.nextCardPullTime)}`,
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
    console.log('Deploying slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands deployed!');
  } catch (err) {
    console.error('Error deploying commands:', err);
  }
})();

// ----------------- Event Listeners -----------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Bot is ready to receive DMs!');
});

client.on('messageCreate', async (msg) => {
  if (msg.author.id === client.user.id) return;

  const channelId = msg.channel.id;

  console.log(`[${new Date().toISOString()}] Message from ${msg.author.tag} in channel ${channelId}`);

  try {
    // Process message through handlers
    handleManualCardPullReset(msg, channelId) ||
      handlePullWaitMessage(msg, channelId) ||
      handleCooldownMessage(msg, channelId) ||
      (handleCardPullMessage(msg, channelId) &&
        handleNextRescueMessage(msg, channelId)) ||
      handleTimerCommand(msg, channelId);
  } catch (err) {
    console.error('Error handling message:', err);
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
    const timers = getChannelTimers(channelId);
    const hasNoTimers = !timers.nextRescueTime && !timers.nextCardPullTime;

    const response = [
      `🐾 Next Rescue: ${formatTimerStatus(timers.nextRescueTime)}`,
      `🎴 Next Card Pull: ${formatTimerStatus(timers.nextCardPullTime)}`,
      hasNoTimers ? `\n${MESSAGES.noTimersSet}` : '',
    ].filter(Boolean).join('\n');

    await interaction.reply(response);
  }
});

client.login(TOKEN);