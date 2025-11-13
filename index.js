require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const cooldownRegex = /you can rescue another animal in \*\*(.*?)\*\*/i;

// Mutable interval
let intervalMinutes = 320;
let timer = null;
let nextTrigger = null;
let activeCooldownTimer = null;
let nextRescueTime = null;

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

function scheduleNext(channel) {
  clearTimeout(timer);
  nextTrigger = Date.now() + intervalMinutes * 60 * 1000;
  timer = setTimeout(() => sendChannelMessage(), intervalMinutes * 60 * 1000);
}

function parseCooldown(cooldownStr) {
  cooldownStr = cooldownStr.replace(/\*/g, '').trim();
  const parts = cooldownStr.split(':').map(Number).reverse();
  let ms = 0;
  if (parts.length >= 1) ms += parts[0] * 1000;             // seconds
  if (parts.length >= 2) ms += parts[1] * 60 * 1000;        // minutes
  if (parts.length >= 3) ms += parts[2] * 60 * 60 * 1000;   // hours
  return ms;
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

  const match = msg.content.match(cooldownRegex);
  if (match) {
    const cooldownMs = parseCooldown(match[1]);
    if (activeCooldownTimer) clearTimeout(activeCooldownTimer);
    nextRescueTime = Date.now() + cooldownMs;

    activeCooldownTimer = setTimeout(() => {
      msg.channel.send('⏰ Your rescue is ready!');
      activeCooldownTimer = null;
      nextRescueTime = null;
      nextRescueTime = Date.now() + intervalMinutes * 60 * 1000;
    }, cooldownMs);

    console.log(`Cooldown timer set for ${cooldownMs / 1000}s`);
  }

  const content = msg.content.trim().toLowerCase();
  if (content === '!timer') {
    if (!nextRescueTime) {
      msg.channel.send('No active rescue timer.');
      return;
    }
    const remainingMs = nextRescueTime - Date.now();
    if (remainingMs <= 0) {
      msg.channel.send('Rescue is ready now!');
      return;
    }
    const hrs = Math.floor(remainingMs / 3600000);
    const mins = Math.floor((remainingMs % 3600000) / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    msg.channel.send(`Next rescue in ${hrs > 0 ? hrs + 'h ' : ''}${mins > 0 ? mins + 'm ' : ''}${secs}s`);
  }
});

// ----------------- Slash Command Handling -----------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'timer') {
    if (!nextRescueTime) {
      await interaction.reply('No active rescue timer.');
      return;
    }
    const remainingMs = nextRescueTime - Date.now();
    if (remainingMs <= 0) {
      await interaction.reply('Rescue is ready now!');
      return;
    }
    const hrs = Math.floor(remainingMs / 3600000);
    const mins = Math.floor((remainingMs % 3600000) / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    await interaction.reply(
      `Next rescue in ${hrs > 0 ? hrs + 'h ' : ''}${mins > 0 ? mins + 'm ' : ''}${secs}s`
    );
  }
});

client.login(TOKEN);
