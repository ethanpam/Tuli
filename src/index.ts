import { Client, Events, GatewayIntentBits, OAuth2Scopes, PermissionFlagsBits } from "discord.js";
import { db } from "./db.js";
import { features } from "./features/index.js";
import { createRouter } from "./router.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and paste your bot token into it.");
  process.exit(1);
}

// Everything Tuli needs to do its jobs. Opening the invite link again updates Tuli's role.
const PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

const router = createRouter(features);

// Intents tell Discord which events to send us. We don't need the privileged
// MessageContent intent yet: Discord always includes the text of messages that
// mention the bot, and of messages someone right-clicks → Apps on.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  // Never let text from users (quotes, questions...) ping @everyone or roles by accident.
  allowedMentions: { parse: ["users"] },
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} (in ${readyClient.guilds.cache.size} servers)`);
  console.log(`Invite link: ${readyClient.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: PERMISSIONS })}`);

  // Replaces Tuli's registered commands with the current ones, so edits show up on restart.
  try {
    const registered = await readyClient.application.commands.set(router.commandData());
    console.log(`Registered ${registered.size} commands`);
  } catch (error) {
    console.error("Couldn't register commands:", error);
  }

  for (const feature of features) feature.onReady?.(readyClient);
});

client.on(Events.InteractionCreate, (interaction) => router.handleInteraction(interaction));
client.on(Events.MessageCreate, (message) => router.handleMessage(message));
client.on(Events.Error, (error) => console.error("Discord client error:", error));

async function shutDown() {
  await client.destroy();
  db.close();
  process.exit(0);
}
process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);

await client.login(token);
