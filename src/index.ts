import {
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type Message,
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and paste your bot token into it.");
  process.exit(1);
}

// Intents tell Discord which events to send us. We don't need the privileged
// MessageContent intent yet: Discord always includes the text of messages that
// mention the bot.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const greetings = ["Hi", "Hey", "Hello", "Yo", "Howdy"];

// Decides whether a message is aimed at Tuli. `message.client.user` is Tuli itself.
function isTalkingToTuli(message: Message): boolean {
  const tuli = message.client.user;
  // @everyone/@here and plain replies to Tuli's posts don't count, so announcements
  // and people answering Tuli (e.g. a daily question) don't trigger greetings.
  const options = { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true };
  if (message.mentions.has(tuli, options)) return true;

  // Typing @Tuli can autocomplete to Tuli's auto-created role instead of the user.
  const tuliRole = message.guild?.members.me?.roles.botRole;
  return tuliRole ? message.mentions.roles.has(tuliRole.id) : false;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  // Add to this list as features need more permissions, then re-open the link.
  const invite = readyClient.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  });
  console.log(`Invite link: ${invite}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore other bots (and ourselves) so two bots can't get stuck replying to each other.
  if (message.author.bot) return;
  if (!isTalkingToTuli(message)) return;

  const greeting = greetings[Math.floor(Math.random() * greetings.length)];
  const name = message.member?.displayName ?? message.author.displayName;
  try {
    await message.reply(`${greeting}, ${name}! 👋`);
  } catch (error) {
    // Usually means Tuli lacks Send Messages permission in this channel.
    console.error(`Couldn't reply in #${message.channelId}:`, error);
  }
});

client.login(token);
