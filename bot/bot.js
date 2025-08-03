const { Client, GatewayIntentBits, Partials } = require('discord.js');
const dotenv = require('dotenv');
const mentionHandler = require('./mentionHandler');
const reactionHandler = require('./reactionHandler');

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.mentions.has(client.user)) {
    await mentionHandler.handleMention(message, client);
  }
});

client.on('messageReactionAdd', reactionHandler.handleReaction);

client.login(process.env.DISCORD_TOKEN);
