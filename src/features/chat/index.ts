import {
  ApplicationCommandType,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type GuildMember,
  type Message,
} from "discord.js";
import { getSetting, getTimezone, setSetting } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import { friendlyDateTime, localDate } from "../../time.js";
import type { AdminGroup, Feature, ModalHandler } from "../../types.js";
import { Colors, embed, notice, replyNotice, truncate } from "../../ui.js";
import { upcomingEvents } from "../events/store.js";
import { commandSections } from "../help.js";
import { converse, GeminiError, geminiConfig, type Content, type GeminiConfig } from "./gemini.js";
import { buildSystemPrompt, DEFAULT_PERSONALITY } from "./persona.js";
import { createTools } from "./tools.js";

const COOLDOWN_MS = 5_000;
const DAILY_LIMIT = 400;
const HISTORY_LENGTH = 10;
const MAX_REPLY = 1_900;
const KEY_URL = "https://aistudio.google.com/apikey";

// ─── When is someone talking to Tuli? ────────────────────────────────────────

function tuliRoleId(message: Message<true>): string | undefined {
  return message.guild.members.me?.roles.botRole?.id;
}

function mentionsTuli(message: Message<true>): boolean {
  const roleId = tuliRoleId(message);
  return message.mentions.users.has(message.client.user.id) || (!!roleId && message.mentions.roles.has(roleId));
}

/** The message as plain text for the model: Tuli's mention removed, other mentions turned into names. */
export function readableText(message: Message<true>): string {
  const tuliId = message.client.user.id;
  const roleId = tuliRoleId(message);
  return message.content
    .replace(new RegExp(`^\\s*<@!?${tuliId}>|^\\s*<@&${roleId ?? "none"}>`, "g"), "")
    .replace(/<@!?(\d+)>/g, (_, id: string) =>
      id === tuliId
        ? "Tuli"
        : `@${message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.displayName ?? "someone"}`,
    )
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${message.guild.roles.cache.get(id)?.name ?? "role"}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${message.guild.channels.cache.get(id)?.name ?? "channel"}`)
    .trim()
    .slice(0, 1_500);
}

/** Whether chat will answer this message (a mention with something to say), so the greeting stays quiet. */
export function chatWillAnswer(message: Message<true>): boolean {
  return chatEnabled(message.guildId) && mentionsTuli(message) && (readableText(message) !== "" || !!message.reference);
}

/** A chat message from Tuli: plain text, unlike its posts with embeds and buttons (questions, level-ups...). */
function isChatMessage(message: Message, tuliId: string): boolean {
  return message.author.id === tuliId && message.embeds.length === 0 && message.components.length === 0;
}

/** The message someone replied to, if it's one of Tuli's chat messages. */
async function repliedChat(message: Message<true>): Promise<Message | null> {
  const tuliId = message.client.user.id;
  if (!message.reference?.messageId || message.mentions.repliedUser?.id !== tuliId) return null;
  const replied = await message.fetchReference().catch(() => null);
  return replied && isChatMessage(replied, tuliId) ? replied : null;
}

/** The conversation so far, by following the chain of replies back from this message. */
async function history(message: Message<true>): Promise<Content[]> {
  const tuliId = message.client.user.id;
  const turns: Content[] = [];
  let current: Message = message;
  while (turns.length < HISTORY_LENGTH && current.reference?.messageId) {
    const previous: Message | null = await current.fetchReference().catch(() => null);
    if (!previous?.inGuild()) break;
    const fromTuli = previous.author.id === tuliId;
    const text = fromTuli
      ? previous.content
      : `${previous.member?.displayName ?? previous.author.displayName}: ${readableText(previous)}`;
    if (text.trim()) turns.unshift({ role: fromTuli ? "model" : "user", parts: [{ text }] });
    current = previous;
  }
  return turns;
}

/** Joins back-to-back turns from the same side, and makes sure the model sees a user turn first. */
export function tidyTurns(turns: Content[]): Content[] {
  const tidy: Content[] = [];
  for (const turn of turns) {
    const last = tidy.at(-1);
    if (last?.role === turn.role) last.parts.push(...turn.parts);
    else tidy.push({ role: turn.role, parts: [...turn.parts] });
  }
  if (tidy[0]?.role === "model") tidy.unshift({ role: "user", parts: [{ text: "(earlier in the conversation)" }] });
  return tidy;
}

// ─── Talking ─────────────────────────────────────────────────────────────────

/** The commands everyone can use, as clickable </command:id> lines for the model to point people to. */
function commandList(client: Client<true>): string[] {
  return [...client.application.commands.cache.values()]
    .filter((command) => command.type === ApplicationCommandType.ChatInput && !command.defaultMemberPermissions)
    .flatMap((command) => commandSections(command).flatMap((section) => section.lines));
}

export function systemPromptFor(member: GuildMember): string {
  const guildId = member.guild.id;
  const timezone = getTimezone(guildId);
  const events = upcomingEvents(guildId, 5).map((event) =>
    [event.title, friendlyDateTime(event.starts_at, timezone), event.location].filter(Boolean).join(" · "),
  );
  return buildSystemPrompt({
    serverName: member.guild.name,
    about: getSetting(guildId, "aiAbout") ?? "",
    personality: getSetting(guildId, "aiPersonality") ?? DEFAULT_PERSONALITY,
    now: `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(new Date())}, ${friendlyDateTime(Date.now(), timezone).split(" at ")[1]}`,
    timezone,
    events,
    commands: commandList(member.client),
    speaker: member.displayName,
  });
}

/** Gets Tuli's reply to a member, given the conversation so far (ending with what they just said). */
export async function reply(config: GeminiConfig, member: GuildMember, turns: Content[]): Promise<string> {
  const text = await converse(config, systemPromptFor(member), tidyTurns(turns), createTools(member));
  return truncate(text.replace(/^\s*tuli\s*:\s*/i, ""), MAX_REPLY);
}

const FRIENDLY_ERRORS: Record<GeminiError["kind"], string> = {
  "rate-limit": "my brain needs a sec 😵‍💫 too many people talking to me at once. try again in a minute?",
  unavailable: "ugh, I'm having trouble thinking right now. try me again in a bit?",
  blocked: "hmm, I'd rather not go there. ask me something else?",
  auth: "I can't chat right now. the officers need to check my settings!",
  other: "sorry, I lost my train of thought. can you say that again?",
};

const cooldowns = new Map<string, number>();
const usage = new Map<string, { day: string; count: number }>();
let warnedAboutKey = false;
const inFlight = new Set<Promise<void>>();

/** Resolves once every reply Tuli is writing has been sent (for tests and screenshots). */
export async function chatsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

function usedToday(guildId: string): number {
  const today = localDate(getTimezone(guildId));
  const entry = usage.get(guildId);
  return entry?.day === today ? entry.count : 0;
}

function countUse(guildId: string) {
  usage.set(guildId, { day: localDate(getTimezone(guildId)), count: usedToday(guildId) + 1 });
}

function chatChannelAllowed(message: Message<true>): boolean {
  const allowed = getSetting(message.guildId, "aiChannelId");
  if (!allowed) return true;
  return message.channelId === allowed || (message.channel.isThread() && message.channel.parentId === allowed);
}

async function handleChat(message: Message<true>): Promise<void> {
  const config = geminiConfig();
  if (!config || !getSetting(message.guildId, "aiEnabled")) return;

  const mentioned = mentionsTuli(message);
  const repliedTo = mentioned ? null : await repliedChat(message);
  if (!mentioned && !repliedTo) return;
  // A bare "@Tuli" is just a hello; the greeting feature answers that.
  if (mentioned && !message.reference && readableText(message) === "") return;

  const quietly = { allowedMentions: { parse: [], repliedUser: false } } as const;
  if (!chatChannelAllowed(message)) {
    if (mentioned)
      await message
        .reply({
          content: `come find me in <#${getSetting(message.guildId, "aiChannelId")}> and we can chat! 🐰`,
          ...quietly,
        })
        .catch(() => {});
    return;
  }

  const who = `${message.guildId}:${message.author.id}`;
  if (Date.now() - (cooldowns.get(who) ?? 0) < COOLDOWN_MS) {
    await message.react("⏳").catch(() => {});
    return;
  }
  if (usedToday(message.guildId) >= DAILY_LIMIT) {
    await message.reply({ content: "I'm all talked out for today 😴 catch me tomorrow!", ...quietly }).catch(() => {});
    return;
  }
  cooldowns.set(who, Date.now());
  countUse(message.guildId);

  const member = message.member ?? (await message.guild.members.fetch(message.author.id));
  await message.channel.sendTyping().catch(() => {});
  let text: string;
  try {
    const turns = [
      ...(await history(message)),
      { role: "user" as const, parts: [{ text: `${member.displayName}: ${readableText(message)}` }] },
    ];
    text = await reply(config, member, turns);
  } catch (error) {
    const kind = error instanceof GeminiError ? error.kind : "other";
    console.error(`Chat failed in ${message.guild.name}:`, error);
    if (kind === "auth" && !warnedAboutKey) {
      warnedAboutKey = true;
      await sendStaffLog(message.guild, {
        embeds: [
          notice(
            "warning",
            `Gemini rejected Tuli's API key, so chatting is broken. Check GEMINI_API_KEY in .env (${KEY_URL}) and restart Tuli.`,
          ),
        ],
      });
    }
    text = FRIENDLY_ERRORS[kind];
  }
  await message
    .reply({ content: text, ...quietly })
    .catch((error) => console.error("Couldn't send a chat reply:", error));
}

// ─── Staff controls ──────────────────────────────────────────────────────────

function textModal(
  customId: string,
  title: string,
  label: string,
  description: string,
  value: string,
  placeholder: string,
) {
  const input = new TextInputBuilder()
    .setCustomId("text")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(false)
    .setPlaceholder(placeholder);
  if (value) input.setValue(value);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(input));
}

const aiAdmin: AdminGroup = {
  name: "ai",
  description: "Chatting with Tuli (powered by Google Gemini)",
  build: (group) =>
    group
      .addSubcommand((sub) => sub.setName("status").setDescription("See how chatting is set up"))
      .addSubcommand((sub) =>
        sub
          .setName("enable")
          .setDescription("Let members chat with Tuli by mentioning it")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Only chat in this channel (leave empty for everywhere)")
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) => sub.setName("disable").setDescription("Turn chatting off"))
      .addSubcommand((sub) => sub.setName("about").setDescription("Tell Tuli about the server and group"))
      .addSubcommand((sub) => sub.setName("personality").setDescription("Change how Tuli talks"))
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Try chatting with Tuli privately")
          .addStringOption((o) =>
            o.setName("message").setDescription("What to say to Tuli").setRequired(true).setMaxLength(1000),
          ),
      ),

  async execute(interaction) {
    const { guildId } = interaction;
    const config = geminiConfig();
    const noKey = `Tuli needs a Gemini API key first. Get a free one at ${KEY_URL}, add \`GEMINI_API_KEY=...\` to Tuli's \`.env\`, then restart Tuli.`;

    switch (interaction.options.getSubcommand()) {
      case "status": {
        const enabled = getSetting(guildId, "aiEnabled") ?? false;
        const channelId = getSetting(guildId, "aiChannelId");
        const about = getSetting(guildId, "aiAbout") ?? "";
        const personality = getSetting(guildId, "aiPersonality");
        const status = embed(enabled && config ? Colors.success : Colors.brand)
          .setTitle("🤖 Chatting with Tuli")
          .addFields(
            {
              name: "Chat",
              value: enabled ? (channelId ? `On, in <#${channelId}>` : "On, everywhere") : "Off",
              inline: true,
            },
            { name: "Gemini key", value: config ? `✅ Set · \`${config.model}\`` : "❌ Missing", inline: true },
            { name: "Replies today", value: `${usedToday(guildId)} / ${DAILY_LIMIT}`, inline: true },
            {
              name: "What Tuli knows",
              value: about ? truncate(about, 300) : "Nothing yet. Add it with `/admin ai about`.",
            },
            {
              name: "Personality",
              value: personality
                ? `Custom: ${truncate(personality.split("\n")[0] ?? "", 150)}`
                : "The default (casual, friendly bunny)",
            },
            {
              name: "Privacy",
              value:
                "With a free Gemini key, Google may use what members say to Tuli to improve its products, and people may review it. Members should know that before chatting.",
            },
          );
        await interaction.reply({ embeds: [status], flags: MessageFlags.Ephemeral });
        return;
      }

      case "enable": {
        if (!config) {
          await replyNotice(interaction, "error", noKey);
          return;
        }
        const channel = interaction.options.getChannel("channel", false, [ChannelType.GuildText]);
        setSetting(guildId, "aiEnabled", true);
        setSetting(guildId, "aiChannelId", channel?.id);
        const tip = getSetting(guildId, "aiAbout") ? "" : "\nNext: tell Tuli about your group with `/admin ai about`.";
        await replyNotice(
          interaction,
          "success",
          `Chatting is on${channel ? ` in ${channel}` : " everywhere"}. Members mention Tuli to talk, and reply to keep going.${tip}\n` +
            "-# Heads up: with a free Gemini key, Google may use what people say to Tuli to improve its products. Let your members know.",
        );
        return;
      }

      case "disable": {
        setSetting(guildId, "aiEnabled", false);
        await replyNotice(interaction, "success", "Chatting is off. Mentioning Tuli just gets a hello again.");
        return;
      }

      case "about": {
        await interaction.showModal(
          textModal(
            "ai-about",
            "What should Tuli know?",
            "About this server and group",
            "What the group is, what you do, when you meet, who the officers are, links, inside jokes...",
            getSetting(guildId, "aiAbout") ?? "",
            "e.g. We're ASU at Iowa State. GBMs are every other Thursday at 6:30 in the MU...",
          ),
        );
        return;
      }

      case "personality": {
        await interaction.showModal(
          textModal(
            "ai-personality",
            "Tuli's personality",
            "How Tuli talks",
            "Clear it all out to go back to the default.",
            getSetting(guildId, "aiPersonality") ?? DEFAULT_PERSONALITY,
            "Describe who Tuli is and how it talks",
          ),
        );
        return;
      }

      case "test": {
        if (!config) {
          await replyNotice(interaction, "error", noKey);
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const said = interaction.options.getString("message", true);
        try {
          const text = await reply(config, interaction.member, [
            { role: "user", parts: [{ text: `${interaction.member.displayName}: ${said}` }] },
          ]);
          await interaction.editReply({ content: `> ${said}\n${text}` });
        } catch (error) {
          const kind = error instanceof GeminiError ? error.kind : "other";
          await replyNotice(
            interaction,
            "error",
            `Gemini said no (${kind}): ${error instanceof Error ? error.message : error}`,
          );
        }
        return;
      }
    }
  },
};

const modals: ModalHandler[] = [
  {
    prefix: "ai-about",
    async execute(interaction) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return;
      const text = interaction.fields.getTextInputValue("text").trim();
      setSetting(interaction.guildId, "aiAbout", text || undefined);
      await replyNotice(
        interaction,
        "success",
        text ? "Got it. Tuli knows about your group now." : "Cleared what Tuli knows about the group.",
      );
    },
  },
  {
    prefix: "ai-personality",
    async execute(interaction) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return;
      const text = interaction.fields.getTextInputValue("text").trim();
      const custom = text && text !== DEFAULT_PERSONALITY ? text : undefined;
      setSetting(interaction.guildId, "aiPersonality", custom);
      await replyNotice(
        interaction,
        "success",
        custom
          ? "Tuli's personality is updated. Try it with `/admin ai test`."
          : "Tuli is back to its default personality.",
      );
    },
  },
];

export function chatEnabled(guildId: string): boolean {
  return !!geminiConfig() && (getSetting(guildId, "aiEnabled") ?? false);
}

export const chatFeature: Feature = {
  name: "Chat",
  admin: aiAdmin,
  modals,
  // Chatting waits on Gemini, so it runs in the background instead of holding up XP and the rest.
  async onMessage(message) {
    const task: Promise<void> = handleChat(message)
      .catch((error) => console.error("Chat failed:", error))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  },

  describeSettings(guild) {
    const config = geminiConfig();
    const enabled = getSetting(guild.id, "aiEnabled") ?? false;
    const channelId = getSetting(guild.id, "aiChannelId");
    const lines = [
      enabled ? (channelId ? `On, in <#${channelId}>` : "On, everywhere") : "Off. Turn it on with `/admin ai enable`.",
    ];
    if (!config) lines.push(`⚠️ Needs a Gemini API key in \`.env\` (free at ${KEY_URL}).`);
    else if (enabled && !getSetting(guild.id, "aiAbout"))
      lines.push("⚠️ Tell Tuli about your group with `/admin ai about`.");
    return [{ name: "🤖 Chat", value: lines.join("\n") }];
  },
};
