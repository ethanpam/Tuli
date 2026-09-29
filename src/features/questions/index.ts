import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  messageLink,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  time,
  TimestampStyles,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { getSetting, getTimezone, guildsWithSetting, setSetting, type QuestionSchedule } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import { hourLabel, WEEKDAYS } from "../../time.js";
import type { AdminGroup, ComponentHandler, Feature, SlashCommand } from "../../types.js";
import { Colors, embed, formatPoints, notice, oneLine, plural, replyNotice, truncate } from "../../ui.js";
import { changePoints } from "../economy/store.js";
import { describeSchedule, isDue, nextPostAt, questionLabel } from "./schedule.js";
import {
  addQuestion,
  approveSuggestion,
  claimNextQuestion,
  countByStatus,
  findWaitingDuplicate,
  getQuestion,
  latestPosted,
  listByStatus,
  questionForThread,
  recordAnswer,
  recordPost,
  rejectSuggestion,
  removeQuestion,
  unclaimQuestion,
  type Question,
} from "./store.js";

export const ANSWER_POINTS = 10;
const MAX_QUESTION_LENGTH = 300;
const CHECK_EVERY_MS = 30_000;
const LOW_QUEUE_WARNING = 2;

// Permissions Tuli needs in the question channel.
const CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

function questionChannel(guild: Guild): GuildTextBasedChannel | null {
  const channelId = getSetting(guild.id, "questionChannelId");
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  return channel?.isTextBased() && !channel.isThread() && !channel.isVoiceBased() ? channel : null;
}

/**
 * Posts the next queued question with an answer thread. Returns the question, or an
 * explanation of why nothing was posted.
 */
async function postNextQuestion(guild: Guild): Promise<{ question: Question } | { problem: string }> {
  const channel = questionChannel(guild);
  if (!channel) return { problem: "No question channel is set up. Use `/admin questions schedule` to pick one." };
  if (!channel.permissionsFor(guild.client.user)?.has(CHANNEL_PERMISSIONS)) {
    return { problem: `Tuli needs View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads in ${channel}.` };
  }
  const question = claimNextQuestion(guild.id);
  if (!question) return { problem: "The question queue is empty. Add some with `/admin questions add`." };

  const schedule = getSetting(guild.id, "questionSchedule");
  const label = `${questionLabel(schedule)} #${question.number}`;
  const pingRoleId = getSetting(guild.id, "questionPingRoleId");
  const post = embed()
    .setAuthor({ name: label, iconURL: guild.iconURL() ?? undefined })
    .setDescription(`## ${question.text}`)
    .setFooter({ text: `Answer in the thread below · your first answer earns ${ANSWER_POINTS} points` });

  try {
    const message = await channel.send({
      content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
      embeds: [post],
      allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] },
    });
    const thread = await message
      .startThread({
        name: truncate(`💬 ${label}: ${oneLine(question.text)}`, 100),
        autoArchiveDuration: schedule?.frequency === "weekly" ? ThreadAutoArchiveDuration.OneWeek : ThreadAutoArchiveDuration.OneDay,
      })
      .catch(() => null);
    recordPost(question.id, channel.id, message.id, thread?.id ?? null);
  } catch (error) {
    unclaimQuestion(question.id);
    console.error(`Couldn't post a question in ${guild.name}:`, error);
    return { problem: `Discord wouldn't let Tuli post in ${channel}.` };
  }

  const left = countByStatus(guild.id, "queued");
  if (left <= LOW_QUEUE_WARNING) {
    await sendStaffLog(guild, {
      embeds: [notice("warning", left === 0 ? "That was the last queued question. Add more with `/admin questions add`." : `Only ${plural(left, "question")} left in the queue.`)],
    });
  }
  return { question };
}

/** Checks every server's schedule and posts questions that are due. */
function startScheduler(client: Client<true>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const { guildId, value: schedule } of guildsWithSetting("questionSchedule")) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const lastRunAt = getSetting(guildId, "questionLastRunAt") ?? now;
        if (!isDue(schedule, getTimezone(guildId), lastRunAt, now)) continue;
        setSetting(guildId, "questionLastRunAt", now);
        const result = await postNextQuestion(guild);
        if ("problem" in result) {
          await sendStaffLog(guild, { embeds: [notice("warning", `Tuli skipped a scheduled question. ${result.problem}`)] });
        }
      }
    } catch (error) {
      console.error("Question scheduler failed:", error);
    } finally {
      running = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS);
  void tick();
}

function reviewButtons(questionId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`question-review:${questionId}:approve`).setLabel("Add to queue").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`question-review:${questionId}:reject`).setLabel("Reject").setStyle(ButtonStyle.Danger),
  );
}

const questionCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("question")
    .setDescription("The daily/weekly question")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName("today").setDescription("Jump to the latest question"))
    .addSubcommand((sub) =>
      sub
        .setName("suggest")
        .setDescription("Suggest a question for the server")
        .addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH)),
    ),

  async execute(interaction) {
    const { guild } = interaction;
    if (interaction.options.getSubcommand() === "today") {
      const question = latestPosted(guild.id);
      if (!question?.channel_id || !question.message_id) {
        await replyNotice(interaction, "info", "No questions have been posted yet.");
        return;
      }
      const where = question.thread_id ? `<#${question.thread_id}>` : `[the post](${messageLink(question.channel_id, question.message_id, guild.id)})`;
      const card = embed()
        .setAuthor({ name: `${questionLabel(getSetting(guild.id, "questionSchedule"))} #${question.number}` })
        .setDescription(`## ${question.text}\nAnswer in ${where} · your first answer earns ${formatPoints(ANSWER_POINTS)}`)
        .setTimestamp(question.posted_at);
      await interaction.reply({ embeds: [card], flags: MessageFlags.Ephemeral });
      return;
    }

    // suggest
    const text = interaction.options.getString("question", true);
    if (!getSetting(guild.id, "logChannelId")) {
      await replyNotice(interaction, "info", "Question suggestions aren't open in this server yet.");
      return;
    }
    if (findWaitingDuplicate(guild.id, text)) {
      await replyNotice(interaction, "info", "Someone already suggested that one. Great minds!");
      return;
    }
    const suggestion = addQuestion(guild.id, text, interaction.user.id, "suggested");
    const card = embed(Colors.brand)
      .setTitle("💡 Question suggestion")
      .setDescription(`## ${suggestion.text}\nSuggested by ${interaction.user}`)
      .setTimestamp();
    const posted = await sendStaffLog(guild, { embeds: [card], components: [reviewButtons(suggestion.id)] });
    if (!posted) {
      rejectSuggestion(guild.id, suggestion.id);
      await replyNotice(interaction, "error", "Tuli couldn't reach the staff channel, so your suggestion wasn't sent. Please try again later.");
      return;
    }
    await replyNotice(interaction, "success", "Thanks! Your question was sent to the staff to review.");
  },
};

const reviewHandler: ComponentHandler = {
  prefix: "question-review",
  async execute(interaction, [id = "0", action]) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await replyNotice(interaction, "error", "Only staff with Manage Server can review suggestions.");
      return;
    }
    const { guild } = interaction;
    const question = getQuestion(guild.id, Number(id));
    const done = action === "approve" ? approveSuggestion(guild.id, Number(id)) : rejectSuggestion(guild.id, Number(id));
    if (!done || !question) {
      await replyNotice(interaction, "info", "Someone already reviewed this suggestion.");
      return;
    }
    const [card] = interaction.message.embeds;
    const verdict = action === "approve" ? `✅ Added to the queue by ${interaction.user}` : `❌ Rejected by ${interaction.user}`;
    const updated = embed(action === "approve" ? Colors.success : Colors.danger)
      .setTitle(card?.title ?? "💡 Question suggestion")
      .setDescription(`${card?.description ?? question.text}\n\n${verdict}`);
    await interaction.update({ embeds: [updated], components: [] });

    if (action === "approve") {
      const author = await guild.members.fetch(question.added_by_id).catch(() => null);
      await author
        ?.send({ embeds: [notice("success", `Your question suggestion in **${escapeMarkdown(guild.name)}** was added to the queue: "${escapeMarkdown(question.text)}"`)] })
        .catch(() => {});
    }
  },
};

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ name: hourLabel(hour), value: hour }));
const WEEKDAY_CHOICES = WEEKDAYS.map((name, value) => ({ name, value }));

const questionsAdmin: AdminGroup = {
  name: "questions",
  description: "Daily/weekly questions",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("schedule")
          .setDescription("Where and when questions are posted")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Where to post").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) =>
            o
              .setName("frequency")
              .setDescription("How often")
              .setRequired(true)
              .addChoices({ name: "Every day", value: "daily" }, { name: "Once a week", value: "weekly" }),
          )
          .addIntegerOption((o) => o.setName("hour").setDescription("What time (server timezone)").setRequired(true).addChoices(HOURS))
          .addIntegerOption((o) => o.setName("weekday").setDescription("Which day, for weekly questions").addChoices(WEEKDAY_CHOICES))
          .addRoleOption((o) => o.setName("ping").setDescription("A role to ping with each question")),
      )
      .addSubcommand((sub) => sub.setName("pause").setDescription("Stop posting questions (the queue is kept)"))
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add a question to the queue")
          .addStringOption((o) => o.setName("question").setDescription("The question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH)),
      )
      .addSubcommand((sub) => sub.setName("queue").setDescription("See the questions waiting to be posted"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a question from the queue")
          .addIntegerOption((o) => o.setName("id").setDescription("The ID shown in /admin questions queue").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) => sub.setName("post-now").setDescription("Post the next question right away")),

  async execute(interaction) {
    const { guild } = interaction;
    switch (interaction.options.getSubcommand()) {
      case "schedule": {
        const channel = interaction.options.getChannel("channel", true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
        const frequency = interaction.options.getString("frequency", true) as QuestionSchedule["frequency"];
        const weekday = interaction.options.getInteger("weekday");
        const ping = interaction.options.getRole("ping");
        if (frequency === "weekly" && weekday === null) {
          await replyNotice(interaction, "error", "Pick a `weekday` for weekly questions.");
          return;
        }
        if (!channel.permissionsFor(interaction.client.user)?.has(CHANNEL_PERMISSIONS)) {
          await replyNotice(interaction, "error", `Tuli needs View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads in ${channel}.`);
          return;
        }
        const schedule: QuestionSchedule = { frequency, weekday: weekday ?? 1, hour: interaction.options.getInteger("hour", true) };
        setSetting(guild.id, "questionChannelId", channel.id);
        setSetting(guild.id, "questionSchedule", schedule);
        setSetting(guild.id, "questionPingRoleId", ping?.id);
        setSetting(guild.id, "questionLastRunAt", Date.now());

        const timezone = getTimezone(guild.id);
        const next = nextPostAt(schedule, timezone);
        const queued = countByStatus(guild.id, "queued");
        const lines = [
          `Questions will be posted in ${channel} ${describeSchedule(schedule)} (${timezone}).`,
          `Next one: ${time(next, TimestampStyles.LongDateTime)} (${time(next, TimestampStyles.RelativeTime)})`,
          queued ? `${plural(queued, "question")} in the queue.` : "⚠️ The queue is empty. Add questions with `/admin questions add`.",
        ];
        if (ping && !ping.mentionable && !channel.permissionsFor(interaction.client.user)?.has(PermissionFlagsBits.MentionEveryone)) {
          lines.push(`⚠️ ${ping} can't be pinged. Turn on "Allow anyone to @mention this role" in its settings.`);
        }
        await replyNotice(interaction, "success", lines.join("\n"));
        return;
      }

      case "pause": {
        setSetting(guild.id, "questionSchedule", undefined);
        await replyNotice(interaction, "success", "Questions are paused. The queue is kept; use `/admin questions schedule` to start again.");
        return;
      }

      case "add": {
        const text = interaction.options.getString("question", true);
        const duplicate = findWaitingDuplicate(guild.id, text);
        if (duplicate) {
          await replyNotice(interaction, "info", `That question is already waiting (ID ${duplicate.id}).`);
          return;
        }
        const question = addQuestion(guild.id, text, interaction.user.id, "queued");
        const position = countByStatus(guild.id, "queued");
        await replyNotice(interaction, "success", `Added question ${question.id}. It's number ${position} in the queue.`);
        return;
      }

      case "queue": {
        const queued = listByStatus(guild.id, "queued", 20);
        const total = countByStatus(guild.id, "queued");
        const suggestions = countByStatus(guild.id, "suggested");
        const schedule = getSetting(guild.id, "questionSchedule");
        const lines = queued.map((question, index) => `**${index + 1}.** ${escapeMarkdown(truncate(oneLine(question.text), 90))} \`ID ${question.id}\``);
        const list = embed()
          .setTitle(`❓ Question queue (${total})`)
          .setDescription(lines.join("\n") || "The queue is empty. Add questions with `/admin questions add`.")
          .setFooter({
            text: [
              schedule ? `Posting ${describeSchedule(schedule)}` : "Paused",
              total > queued.length ? `showing the first ${queued.length}` : "",
              suggestions ? `${plural(suggestions, "suggestion")} waiting for review in the staff log` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          });
        await interaction.reply({ embeds: [list], flags: MessageFlags.Ephemeral });
        return;
      }

      case "remove": {
        const id = interaction.options.getInteger("id", true);
        const removed = removeQuestion(guild.id, id);
        await replyNotice(interaction, removed ? "success" : "error", removed ? `Removed question ${id}.` : `There's no waiting question with ID ${id}.`);
        return;
      }

      case "post-now": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await postNextQuestion(guild);
        if ("problem" in result) await replyNotice(interaction, "error", result.problem);
        else await replyNotice(interaction, "success", `Posted question #${result.question.number}.`);
        return;
      }
    }
  },
};

export const questionsFeature: Feature = {
  name: "Questions",
  slashCommands: [questionCommand],
  components: [reviewHandler],
  admin: questionsAdmin,
  permissions: {
    CreatePublicThreads: "open an answer thread for each question",
    SendMessagesInThreads: "post in answer threads",
    AddReactions: "react to question answers",
  },

  onReady: startScheduler,

  async onMessage(message) {
    if (!message.channel.isThread()) return;
    const question = questionForThread(message.channelId);
    if (!question || !recordAnswer(question.id, message.author.id)) return;
    changePoints({
      guildId: message.guildId,
      userId: message.author.id,
      amount: ANSWER_POINTS,
      reason: `Answered question #${question.number}`,
      displayName: message.member?.displayName,
    });
    await message.react("🪙").catch(() => {});
  },

  describeSettings(guild) {
    const schedule = getSetting(guild.id, "questionSchedule");
    const channel = questionChannel(guild);
    const queued = countByStatus(guild.id, "queued");
    const lines = schedule
      ? [
          `Posting in ${channel ?? "a deleted channel"} ${describeSchedule(schedule)}`,
          `Next: ${time(nextPostAt(schedule, getTimezone(guild.id)), TimestampStyles.RelativeTime)} · ${plural(queued, "question")} queued`,
        ]
      : ["Paused. Set it up with `/admin questions schedule`."];
    if (schedule && queued === 0) lines.push("⚠️ The queue is empty.");
    if (schedule && channel && !channel.permissionsFor(guild.client.user)?.has(CHANNEL_PERMISSIONS)) {
      lines.push(`⚠️ Tuli is missing permissions in ${channel}.`);
    }
    return [{ name: "❓ Questions", value: lines.join("\n") }];
  },
};

