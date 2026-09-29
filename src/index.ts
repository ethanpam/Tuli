import { Client, Events, GatewayCloseCodes, GatewayIntentBits } from "discord.js";
import { db } from "./db.js";
import { features } from "./features/index.js";
import { inviteLink } from "./features/setup.js";
import { createRouter } from "./router.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and paste your bot token into it.");
  process.exit(1);
}

const router = createRouter(features);

function createClient(readMessages: boolean): Client {
  const client = new Client({
    // Intents tell Discord which events to send. MessageContent lets scam protection read
    // messages; it's "privileged", so it must also be switched on in the Developer Portal.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      ...(readMessages ? [GatewayIntentBits.MessageContent] : []),
    ],
    // Never let text from users (quotes, questions...) ping @everyone or roles by accident.
    allowedMentions: { parse: ["users"] },
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag} (in ${readyClient.guilds.cache.size} servers)`);
    // Opening this again after Tuli gains features updates its permissions.
    console.log(`Invite link: ${inviteLink(readyClient, features)}`);

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
  return client;
}

let client = createClient(true);
let fellBack = false;

/** If Message Content Intent is off in the Developer Portal, run without it instead of crashing. */
async function runWithoutReadingMessages() {
  if (fellBack) return;
  fellBack = true;
  console.warn(
    "\n⚠️  Message Content Intent is turned off, so scam protection can't read messages.\n" +
      "   Turn it on: https://discord.com/developers/applications → Tuli → Bot → Privileged Gateway Intents\n" +
      "   → Message Content Intent, then restart Tuli. Everything else works in the meantime.\n",
  );
  await client.destroy();
  client = createClient(false);
  await client.login(token);
}

client.on(Events.ShardDisconnect, (event) => {
  if (event.code === GatewayCloseCodes.DisallowedIntents) void runWithoutReadingMessages();
});

async function shutDown() {
  await client.destroy();
  db.close();
  process.exit(0);
}
process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);

try {
  await client.login(token);
} catch (error) {
  if (error instanceof Error && /disallowed intents|DisallowedIntents/i.test(`${error.message} ${"code" in error ? error.code : ""}`)) {
    await runWithoutReadingMessages();
  } else if (!fellBack) {
    throw error;
  }
}
