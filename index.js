require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
// Match either the Zoobot bold cooldown text or a finishes-format like "(finishes in 5:40:00)"
const cooldownRegex = /(?:you can rescue another animal in \*\*(.*?)\*\*|\(finishes in\s*([0-9:]+)\))/i;

// Mutable interval
let activeCooldownTimer = null;
let nextRescueTime = null;
let nextCardPullTime = null;
let nextCardPullTimer = null;

// ----------------- Bot Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL'], // required for DMs
});

// ----------------- Utility Functions -----------------
async function sendChannelMessage() {
  try {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    await channel.send('BOT DEPLOYED AND LISTENING');
    console.log(new Date().toISOString(), 'Message sent.');
  } catch (err) {
    console.error('Failed to send message:', err.message);
  }
}

function parseCooldown(cooldownStr) {
  // Accept H:MM:SS, MM:SS, SS or plain numbers (seconds)
  cooldownStr = (cooldownStr || '').replace(/\*/g, '').trim();
  const parts = cooldownStr.split(':').map(Number).reverse();
  let ms = 0;
  if (parts.length >= 1) ms += (Number.isFinite(parts[0]) ? parts[0] : 0) * 1000;             // seconds
  if (parts.length >= 2) ms += (Number.isFinite(parts[1]) ? parts[1] : 0) * 60 * 1000;        // minutes
  if (parts.length >= 3) ms += (Number.isFinite(parts[2]) ? parts[2] : 0) * 60 * 60 * 1000;   // hours
  return ms;
}

function formatRemaining(ms) {
  if (!ms || ms <= 0) return '0s';
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${hrs > 0 ? hrs + 'h ' : ''}${mins > 0 ? mins + 'm ' : ''}${secs}s`;
}

function absoluteFromParts(timeStr, ts) {
  // Returns absolute timestamp (ms)
  if (ts) return Number(ts) * 1000;
  if (/now/i.test(timeStr)) return Date.now();
  const delta = parseCooldown(timeStr);
  return Date.now() + delta;
}

// Parse human-readable durations like "3 hours and 31 minutes", "2h 5m", "45 minutes".
function parseHumanDuration(text) {
  if (!text) return 0;
  text = text.toLowerCase();
  // find number+unit tokens
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
  // fallback: if the text is just a plain number, treat as minutes
  if (ms === 0) {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) ms = Math.round(n * 60 * 1000);
  }
  return ms;
}

function clearTimer(ref) {
  if (ref && typeof ref === 'object' && ref.timer) {
    clearTimeout(ref.timer);
    ref.timer = null;
  }
}

function setRescueTimer(rescueTimeMs, channel, notify = false) {
  // clear existing
  if (activeCooldownTimer) {
    clearTimeout(activeCooldownTimer);
    activeCooldownTimer = null;
  }
  nextRescueTime = rescueTimeMs;
  const delay = rescueTimeMs - Date.now();
  if (delay <= 0) {
    channel.send('⏰ Your rescue is ready!');
    nextRescueTime = null;
    return;
  }
  activeCooldownTimer = setTimeout(() => {
    channel.send('⏰ Your rescue is ready!');
    activeCooldownTimer = null;
    nextRescueTime = null;
    // keep cadence
    // nextRescueTime = Date.now() + intervalMinutes * 60 * 1000;
  }, delay);
  console.log(new Date().toISOString(), `Rescue reminder scheduled in ${Math.round(delay/1000)}s`);
  if (notify) {
    channel.send(`🐾 Next Rescue timer set for ${formatRemaining(delay)}`);
  }
}

function setCardPullTimer(pullTimeMs, channel, notify = false) {
  if (nextCardPullTimer) {
    clearTimeout(nextCardPullTimer);
    nextCardPullTimer = null;
  }
  nextCardPullTime = pullTimeMs;
  const delay = pullTimeMs - Date.now();
  if (delay <= 0) {
    channel.send('🎴 Next Card Pull is ready!');
    nextCardPullTime = null;
    return;
  }
  nextCardPullTimer = setTimeout(() => {
    channel.send('🎴 Next Card Pull is ready!');
    nextCardPullTimer = null;
    nextCardPullTime = null;
  }, delay);
  console.log(new Date().toISOString(), `Card pull reminder scheduled in ${Math.round(delay/1000)}s`);
  if (notify) {
    channel.send(`🎴 Next Card Pull timer set for ${formatRemaining(delay)}`);
  }
}

// ----------------- Deploy Slash Commands -----------------
const commands = [
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Show the remaining time until your next rescue.'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Deploying slash commands...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands deployed!');
  } catch (err) {
    console.error(err);
  }
})();

// ----------------- Event Listeners -----------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  sendChannelMessage();
});

// Listen for Zoobot cooldown messages
client.on('messageCreate', async (msg) => {
  if (msg.channel.id !== TARGET_CHANNEL_ID) return;
  console.log(`Received message: ${msg.content}`);

  // Quick manual reset: if the message is exactly "$ pul", reset card pull to 11.5 hours
  if (msg.content.trim() === '`$ pul`' || msg.content.trim() === '`$ pull`') {
    try {
      const hours = 11.5;
      const ms = Math.round(hours * 60 * 60 * 1000);
      const pullTimeMs = Date.now() + ms;
      setCardPullTimer(pullTimeMs, msg.channel);
    } catch (err) {
      console.error('Error handling $ pul reset:', err);
    }
  }

  // Detect bot reply that tells user to wait, e.g.
  // "please wait 3 hours and 31 minutes before pulling again."
  const pullWaitRegex = /please wait\s+(.+?)\s+before pulling again/i;
  const pullWaitMatch = msg.content.match(pullWaitRegex);
  if (pullWaitMatch) {
    try {
      const durText = pullWaitMatch[1];
      const ms = parseHumanDuration(durText);
      if (ms > 0) {
        const pullTimeMs = Date.now() + ms;
        setCardPullTimer(pullTimeMs, msg.channel);
      }
    } catch (err) {
      console.error('Error handling pull-wait message:', err);
    }
  }

  // ----------------- Cooldown Message Handling -----------------
  const match = msg.content.match(cooldownRegex);
  if (match) {
    // match[1] -> bolded cooldown (e.g. "1:23:45" from **...**)
    // match[2] -> finishes format (e.g. "5:40:00")
    const cooldownStr = match[1] ?? match[2];
    const rescueTimeMs = absoluteFromParts(cooldownStr, null);
    setRescueTimer(rescueTimeMs, msg.channel);
  }

  // ----------------- Card Pull Handling -----------------
  // Look for lines like: "🎴 Next Card Pull: **8:59:35** (<t:1763147491>)" or "🎴 Next Card Pull: **Now!** (<t:1763102085:R>)"
  const cardRegex = /Next Card Pull:\s*\*\*(.*?)\*\*(?:\s*\(<t:(\d+)(?::[A-Za-z])?\)\))?/i;
  const cardMatch = msg.content.match(cardRegex);
  if (cardMatch) {
    try {
      const timeStr = cardMatch[1];
      const ts = cardMatch[2];
      const pullTimeMs = absoluteFromParts(timeStr, ts);
      const fromTd = msg.content.includes('$ td');
      setCardPullTimer(pullTimeMs, msg.channel, fromTd);
    } catch (err) {
      console.error('Error handling Next Card Pull:', err);
    }
  }

  // ----------------- Next Rescue (from summary) Handling -----------------
  // Look for lines like: "🐾 Next Rescue: **03:18** (<t:1763106266>)" or "🐾 Next Rescue: **3:13:03**"
  const nextRescueRegex = /Next Rescue:\s*\*\*(.*?)\*\*(?:\s*\(<t:(\d+)(?::[A-Za-z])?\)\))?/i;
  const nextRescueMatch = msg.content.match(nextRescueRegex);
  if (nextRescueMatch) {
    try {
      const timeStr = nextRescueMatch[1];
      const ts = nextRescueMatch[2];
      const rescueTimeMs = absoluteFromParts(timeStr, ts);
      const fromTd = msg.content.includes('$ td');
      setRescueTimer(rescueTimeMs, msg.channel, fromTd);
    } catch (err) {
      console.error('Error handling Next Rescue summary line:', err);
    }
  }

  // ----------------- !timer message Handling -----------------
  const content = msg.content.trim().toLowerCase();
  if (content === '!timer') {
    const parts = [];
    parts.push(`🐾 Next Rescue: ${nextRescueTime ? (nextRescueTime - Date.now() <= 0 ? 'Ready now!' : formatRemaining(nextRescueTime - Date.now())) : 'No active rescue timer.'}`);
    parts.push(`🎴 Next Card Pull: ${nextCardPullTime ? (nextCardPullTime - Date.now() <= 0 ? 'Ready now!' : formatRemaining(nextCardPullTime - Date.now())) : 'No active card pull timer.'}`);
    msg.channel.send(parts.join('\n'));
  }
});

// ----------------- Slash Command Handling -----------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'timer') {
    const lines = [];
    lines.push(`🐾 Next Rescue: ${nextRescueTime ? (nextRescueTime - Date.now() <= 0 ? 'Ready now!' : formatRemaining(nextRescueTime - Date.now())) : 'No active rescue timer.'}`);
    lines.push(`🎴 Next Card Pull: ${nextCardPullTime ? (nextCardPullTime - Date.now() <= 0 ? 'Ready now!' : formatRemaining(nextCardPullTime - Date.now())) : 'No active card pull timer.'}`);
    await interaction.reply(lines.join('\n'));
  }
});

client.login(TOKEN);
