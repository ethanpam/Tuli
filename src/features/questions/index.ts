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
  type EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { getSetting, getTimezone, guildsWithSetting, setSetting, type QuestionSchedule } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import { hourLabel, WEEKDAYS } from "../../time.js";
import type { AdminGroup, ComponentHandler, Feature, SlashCommand } from "../../types.js";
import { Colors, embed, formatPoints, notice, oneLine, plural, progressBar, replyNotice, truncate } from "../../ui.js";
import { changePoints } from "../economy/store.js";
import { describeSchedule, isDue, nextPostAt, questionLabel } from "./schedule.js";
import {
  addQuestion,
  ANSWER_POINTS,
  answerOf,
  approveSuggestion,
  choiceCounts,
  claimNextQuestion,
  closeQuestion,
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
  TRUE_FALSE,
  unclaimQuestion,
  unclosedQuestions,
  type Question,
  type QuestionFormat,
} from "./store.js";

const MAX_QUESTION_LENGTH = 300;
const MAX_CHOICE_LENGTH = 100;
const CHECK_EVERY_MS = 30_000;
const LOW_QUEUE_WARNING = 2;
const LETTERS = ["A", "B", "C", "D", "E"];
const LETTER_EMOJI = ["🇦", "🇧", "🇨", "🇩", "🇪"];

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

// ─── How questions look ──────────────────────────────────────────────────────

/** "B. Pizza" for multiple choice, "True" for true/false. */
function choiceName(question: Question, index: number): string {
  const choice = question.choices[index] ?? "?";
  return question.kind === "truefalse" ? choice : `${LETTERS[index]}. ${choice}`;
}

/** "multiple choice", "poll", "true/false", or "" for open questions. */
function kindLabel(question: QuestionFormat): string {
  if (question.kind === "truefalse") return "true/false";
  if (question.kind === "choice") return question.answer === null ? "poll" : "multiple choice";
  return "";
}

function choiceList(question: Question): string {
  if (question.kind === "truefalse") return "**True or false?**";
  return question.choices.map((choice, index) => `${LETTER_EMOJI[index]} ${choice}`).join("\n");
}

/** The post for a new question: open questions get a thread, the others get answer buttons. */
export function questionMessage(question: Question, label: string, iconURL?: string) {
  const post = embed().setAuthor({ name: label, iconURL });
  if (question.kind === "open") {
    post
      .setDescription(`## ${question.text}`)
      .setFooter({ text: `Answer in the thread below · your first answer earns ${ANSWER_POINTS} points` });
    return { embeds: [post], components: [] };
  }
  post.setDescription(`## ${question.text}\n\n${choiceList(question)}`).setFooter({
    text:
      question.answer === null
        ? `Vote below · voting earns ${ANSWER_POINTS} points · results when this closes`
        : `Pick an answer below · the right one earns ${ANSWER_POINTS} points when the answer is revealed`,
  });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    question.choices.map((_, index) =>
      new ButtonBuilder()
        .setCustomId(`question-answer:${question.id}:${index}`)
        .setLabel(truncate(choiceName(question, index), 80))
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return { embeds: [post], components: [buttons] };
}

/** The same post once it closes: how many picked each choice, and the right answer. */
export function resultsEmbed(question: Question, label: string, counts: number[], winners: number): EmbedBuilder {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const lines = question.choices.map((choice, index) => {
    const count = counts[index] ?? 0;
    const share = total ? count / total : 0;
    const prefix = question.kind === "truefalse" ? "" : `${LETTER_EMOJI[index]} `;
    const right = question.answer === index ? " ✅" : "";
    return `${prefix}**${choice}**${right}\n${progressBar(share, 10)} ${Math.round(share * 100)}% · ${count}`;
  });
  const summary =
    question.answer === null
      ? `Closed · ${plural(total, "vote")}`
      : `Closed · ${plural(total, "answer")} · ${plural(winners, "person", "people")} got it right`;
  return embed(question.answer === null ? Colors.brand : Colors.success)
    .setAuthor({ name: label })
    .setDescription(`## ${question.text}\n\n${lines.join("\n")}`)
    .setFooter({ text: summary });
}

/** A short announcement under the post, since editing a message doesn't notify anyone. */
function resultsAnnouncement(question: Question, counts: number[], winners: number): string {
  if (question.answer !== null) {
    const who = winners
      ? `${plural(winners, "person", "people")} got it right and earned ${formatPoints(ANSWER_POINTS)}!`
      : "Nobody got it this time!";
    return `📊 The answer was **${choiceName(question, question.answer)}**. ${who}`;
  }
  const top = Math.max(...counts);
  if (top === 0) return "📊 Voting is closed. Nobody voted this time.";
  const leaders = question.choices.flatMap((_, index) =>
    counts[index] === top ? [`**${choiceName(question, index)}**`] : [],
  );
  return leaders.length === 1
    ? `📊 Voting is closed. ${leaders[0]} won!`
    : `📊 Voting is closed. It's a tie: ${leaders.join(" and ")}.`;
}

// ─── Posting and closing ─────────────────────────────────────────────────────

/** Reveals the results of open button questions (except `keepOpenId`) and pays out trivia winners. */
async function closeButtonQuestions(guild: Guild, keepOpenId?: number): Promise<Question[]> {
  const closed: Question[] = [];
  for (const question of unclosedQuestions(guild.id)) {
    if (question.id === keepOpenId) continue;
    const result = closeQuestion(question);
    if (!result) continue; // someone else closed it at the same moment
    closed.push(question);

    const channel = question.channel_id ? guild.channels.cache.get(question.channel_id) : undefined;
    if (!channel?.isTextBased() || !question.message_id) continue;
    const message = await channel.messages.fetch(question.message_id).catch(() => null);
    if (!message) continue;
    const counts = choiceCounts(question);
    const label = message.embeds[0]?.author?.name ?? `Question #${question.number}`;
    await message
      .edit({ embeds: [resultsEmbed(question, label, counts, result.winners.length)], components: [] })
      .catch(() => {});
    await message
      .reply({ content: resultsAnnouncement(question, counts, result.winners.length), allowedMentions: { parse: [] } })
      .catch(() => {});
  }
  return closed;
}

/**
 * Closes the previous button question, then posts the next queued question. Returns the
 * question, or an explanation of why nothing was posted.
 */
async function postNextQuestion(guild: Guild): Promise<{ question: Question } | { problem: string }> {
  const channel = questionChannel(guild);
  if (!channel) return { problem: "No question channel is set up. Use `/admin questions schedule` to pick one." };
  if (!channel.permissionsFor(guild.client.user)?.has(CHANNEL_PERMISSIONS)) {
    return {
      problem: `Tuli needs View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads in ${channel}.`,
    };
  }
  const question = claimNextQuestion(guild.id);
  if (!question) return { problem: "The question queue is empty. Add some with `/admin questions add`." };
  // Reveal the previous question's results. The new one is already marked posted, so leave it open.
  await closeButtonQuestions(guild, question.id);

  const schedule = getSetting(guild.id, "questionSchedule");
  const label = `${questionLabel(schedule)} #${question.number}`;
  const pingRoleId = getSetting(guild.id, "questionPingRoleId");

  try {
    const message = await channel.send({
      content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
      ...questionMessage(question, label, guild.iconURL() ?? undefined),
      allowedMentions: { roles: pingRoleId ? [pingRoleId] : [] },
    });
    const thread =
      question.kind === "open"
        ? await message
            .startThread({
              name: truncate(`💬 ${label}: ${oneLine(question.text)}`, 100),
              autoArchiveDuration:
                schedule?.frequency === "weekly" ? ThreadAutoArchiveDuration.OneWeek : ThreadAutoArchiveDuration.OneDay,
            })
            .catch(() => null)
        : null;
    recordPost(question.id, channel.id, message.id, thread?.id ?? null);
  } catch (error) {
    unclaimQuestion(question.id);
    console.error(`Couldn't post a question in ${guild.name}:`, error);
    return { problem: `Discord wouldn't let Tuli post in ${channel}.` };
  }

  const left = countByStatus(guild.id, "queued");
  if (left <= LOW_QUEUE_WARNING) {
    await sendStaffLog(guild, {
      embeds: [
        notice(
          "warning",
          left === 0
            ? "That was the last queued question. Add more with `/admin questions add`."
            : `Only ${plural(left, "question")} left in the queue.`,
        ),
      ],
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
          await sendStaffLog(guild, {
            embeds: [notice("warning", `Tuli skipped a scheduled question. ${result.problem}`)],
          });
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

// ─── What members use ────────────────────────────────────────────────────────

function reviewButtons(questionId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`question-review:${questionId}:approve`)
      .setLabel("Add to queue")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`question-review:${questionId}:reject`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
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
        .addStringOption((o) =>
          o.setName("question").setDescription("Your question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH),
        ),
    ),

  async execute(interaction) {
    const { guild } = interaction;
    if (interaction.options.getSubcommand() === "today") {
      const question = latestPosted(guild.id);
      if (!question?.channel_id || !question.message_id) {
        await replyNotice(interaction, "info", "No questions have been posted yet.");
        return;
      }
      const where = question.thread_id
        ? `<#${question.thread_id}>`
        : `[the post](${messageLink(question.channel_id, question.message_id, guild.id)})`;
      const next =
        question.kind === "open"
          ? `Answer in ${where} · your first answer earns ${formatPoints(ANSWER_POINTS)}`
          : question.closed_at
            ? `This one is closed. See the results on ${where}.`
            : `${choiceList(question)}\n\nAnswer with the buttons on ${where}`;
      const card = embed()
        .setAuthor({ name: `${questionLabel(getSetting(guild.id, "questionSchedule"))} #${question.number}` })
        .setDescription(`## ${question.text}\n${next}`)
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
      await replyNotice(
        interaction,
        "error",
        "Tuli couldn't reach the staff channel, so your suggestion wasn't sent. Please try again later.",
      );
      return;
    }
    await replyNotice(interaction, "success", "Thanks! Your question was sent to the staff to review.");
  },
};

/** A member clicking an answer button. Answers lock in; trivia points are paid when the answer is revealed. */
const answerHandler: ComponentHandler = {
  prefix: "question-answer",
  async execute(interaction, [id = "0", choiceArg = "0"]) {
    const question = getQuestion(interaction.guildId, Number(id));
    const choice = Number(choiceArg);
    if (!question || question.kind === "open" || question.closed_at !== null || !question.choices[choice]) {
      await replyNotice(interaction, "info", "This question is closed. Check the post for the results.");
      return;
    }
    if (!recordAnswer(question.id, interaction.user.id, choice)) {
      const previous = answerOf(question.id, interaction.user.id) ?? choice;
      await replyNotice(
        interaction,
        "info",
        `You already picked **${choiceName(question, previous)}**. Answers can't be changed.`,
      );
      return;
    }

    const picked = choiceName(question, choice);
    if (question.answer === null) {
      changePoints({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        amount: ANSWER_POINTS,
        reason: `Voted on question #${question.number}`,
        displayName: interaction.member.displayName,
      });
      await replyNotice(
        interaction,
        "success",
        `You voted for **${picked}**. +${formatPoints(ANSWER_POINTS)}\nThe results are shown when the question closes.`,
      );
    } else {
      await replyNotice(
        interaction,
        "success",
        `Locked in: **${picked}**. If it's right, you'll get ${formatPoints(ANSWER_POINTS)} when the answer is revealed.`,
      );
    }
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
    const done =
      action === "approve" ? approveSuggestion(guild.id, Number(id)) : rejectSuggestion(guild.id, Number(id));
    if (!done || !question) {
      await replyNotice(interaction, "info", "Someone already reviewed this suggestion.");
      return;
    }
    const [card] = interaction.message.embeds;
    const verdict =
      action === "approve" ? `✅ Added to the queue by ${interaction.user}` : `❌ Rejected by ${interaction.user}`;
    const updated = embed(action === "approve" ? Colors.success : Colors.danger)
      .setTitle(card?.title ?? "💡 Question suggestion")
      .setDescription(`${card?.description ?? question.text}\n\n${verdict}`);
    await interaction.update({ embeds: [updated], components: [] });

    if (action === "approve") {
      const author = await guild.members.fetch(question.added_by_id).catch(() => null);
      await author
        ?.send({
          embeds: [
            notice(
              "success",
              `Your question suggestion in **${escapeMarkdown(guild.name)}** was added to the queue: "${escapeMarkdown(question.text)}"`,
            ),
          ],
        })
        .catch(() => {});
    }
  },
};

// ─── What staff use ──────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ name: hourLabel(hour), value: hour }));
const WEEKDAY_CHOICES = WEEKDAYS.map((name, value) => ({ name, value }));
const ANSWER_CHOICES = LETTERS.map((letter, value) => ({ name: letter, value }));

/** Reads the A–E choices of /admin questions add-choice, or explains what's wrong with them. */
export function readChoices(get: (name: string) => string | null): { choices: string[] } | { problem: string } {
  const slots = LETTERS.map((letter) => get(`choice-${letter.toLowerCase()}`)?.trim() || null);
  const lastFilled = slots.findLastIndex((slot) => slot !== null);
  const choices = slots.slice(0, lastFilled + 1);
  if (choices.some((choice) => choice === null))
    return { problem: "Fill in the choices in order (A, B, C...) without gaps." };
  const filled = choices as string[];
  if (new Set(filled.map((choice) => choice.toLowerCase())).size !== filled.length) {
    return { problem: "Each choice has to be different." };
  }
  return { choices: filled };
}

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
            o
              .setName("channel")
              .setDescription("Where to post")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) =>
            o
              .setName("frequency")
              .setDescription("How often")
              .setRequired(true)
              .addChoices({ name: "Every day", value: "daily" }, { name: "Once a week", value: "weekly" }),
          )
          .addIntegerOption((o) =>
            o.setName("hour").setDescription("What time (server timezone)").setRequired(true).addChoices(HOURS),
          )
          .addIntegerOption((o) =>
            o.setName("weekday").setDescription("Which day, for weekly questions").addChoices(WEEKDAY_CHOICES),
          )
          .addRoleOption((o) => o.setName("ping").setDescription("A role to ping with each question")),
      )
      .addSubcommand((sub) => sub.setName("pause").setDescription("Stop posting questions (the queue is kept)"))
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add an open question, answered in a thread")
          .addStringOption((o) =>
            o.setName("question").setDescription("The question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH),
          ),
      )
      .addSubcommand((sub) => {
        sub
          .setName("add-choice")
          .setDescription("Add a multiple-choice question, or a poll")
          .addStringOption((o) =>
            o.setName("question").setDescription("The question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH),
          );
        LETTERS.forEach((letter, index) =>
          sub.addStringOption((o) =>
            o
              .setName(`choice-${letter.toLowerCase()}`)
              .setDescription(`Choice ${letter}`)
              .setRequired(index < 2)
              .setMaxLength(MAX_CHOICE_LENGTH),
          ),
        );
        return sub.addIntegerOption((o) =>
          o.setName("answer").setDescription("The right answer (leave empty for a poll)").addChoices(ANSWER_CHOICES),
        );
      })
      .addSubcommand((sub) =>
        sub
          .setName("add-truefalse")
          .setDescription("Add a true/false question")
          .addStringOption((o) =>
            o.setName("statement").setDescription("The statement").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH),
          )
          .addBooleanOption((o) => o.setName("answer").setDescription("Is it true?").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("queue").setDescription("See the questions waiting to be posted"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a question from the queue")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("The ID shown in /admin questions queue").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("post-now").setDescription("Post the next question right away"))
      .addSubcommand((sub) => sub.setName("close").setDescription("Reveal answers and results of button questions")),

  async execute(interaction) {
    const { guild } = interaction;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add" || subcommand === "add-choice" || subcommand === "add-truefalse") {
      const text = interaction.options.getString(subcommand === "add-truefalse" ? "statement" : "question", true);
      let format: QuestionFormat = { kind: "open", choices: [], answer: null };
      if (subcommand === "add-choice") {
        const read = readChoices((name) => interaction.options.getString(name));
        if ("problem" in read) {
          await replyNotice(interaction, "error", read.problem);
          return;
        }
        const answer = interaction.options.getInteger("answer");
        if (answer !== null && answer >= read.choices.length) {
          await replyNotice(interaction, "error", `There's no choice ${LETTERS[answer]}.`);
          return;
        }
        format = { kind: "choice", choices: read.choices, answer };
      } else if (subcommand === "add-truefalse") {
        format = {
          kind: "truefalse",
          choices: TRUE_FALSE,
          answer: interaction.options.getBoolean("answer", true) ? 0 : 1,
        };
      }

      const duplicate = findWaitingDuplicate(guild.id, text);
      if (duplicate) {
        await replyNotice(interaction, "info", `That question is already waiting (ID ${duplicate.id}).`);
        return;
      }
      const question = addQuestion(guild.id, text, interaction.user.id, "queued", format);
      const position = countByStatus(guild.id, "queued");
      const kind = kindLabel(question);
      const answer = question.answer === null ? "" : `\nRight answer: **${choiceName(question, question.answer)}**`;
      await replyNotice(
        interaction,
        "success",
        `Added ${kind ? `${kind} ` : ""}question ${question.id}. It's number ${position} in the queue.${answer}`,
      );
      return;
    }

    switch (subcommand) {
      case "schedule": {
        const channel = interaction.options.getChannel("channel", true, [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ]);
        const frequency = interaction.options.getString("frequency", true) as QuestionSchedule["frequency"];
        const weekday = interaction.options.getInteger("weekday");
        const ping = interaction.options.getRole("ping");
        if (frequency === "weekly" && weekday === null) {
          await replyNotice(interaction, "error", "Pick a `weekday` for weekly questions.");
          return;
        }
        if (!channel.permissionsFor(interaction.client.user)?.has(CHANNEL_PERMISSIONS)) {
          await replyNotice(
            interaction,
            "error",
            `Tuli needs View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads in ${channel}.`,
          );
          return;
        }
        const schedule: QuestionSchedule = {
          frequency,
          weekday: weekday ?? 1,
          hour: interaction.options.getInteger("hour", true),
        };
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
          queued
            ? `${plural(queued, "question")} in the queue.`
            : "⚠️ The queue is empty. Add questions with `/admin questions add`.",
        ];
        if (
          ping &&
          !ping.mentionable &&
          !channel.permissionsFor(interaction.client.user)?.has(PermissionFlagsBits.MentionEveryone)
        ) {
          lines.push(`⚠️ ${ping} can't be pinged. Turn on "Allow anyone to @mention this role" in its settings.`);
        }
        await replyNotice(interaction, "success", lines.join("\n"));
        return;
      }

      case "pause": {
        setSetting(guild.id, "questionSchedule", undefined);
        await replyNotice(
          interaction,
          "success",
          "Questions are paused. The queue is kept; use `/admin questions schedule` to start again.",
        );
        return;
      }

      case "queue": {
        const queued = listByStatus(guild.id, "queued", 20);
        const total = countByStatus(guild.id, "queued");
        const suggestions = countByStatus(guild.id, "suggested");
        const schedule = getSetting(guild.id, "questionSchedule");
        const lines = queued.map((question, index) => {
          const kind = kindLabel(question);
          return `**${index + 1}.** ${escapeMarkdown(truncate(oneLine(question.text), 90))} \`ID ${question.id}\`${kind ? ` · ${kind}` : ""}`;
        });
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
        await replyNotice(
          interaction,
          removed ? "success" : "error",
          removed ? `Removed question ${id}.` : `There's no waiting question with ID ${id}.`,
        );
        return;
      }

      case "post-now": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await postNextQuestion(guild);
        if ("problem" in result) await replyNotice(interaction, "error", result.problem);
        else await replyNotice(interaction, "success", `Posted question #${result.question.number}.`);
        return;
      }

      case "close": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const closed = await closeButtonQuestions(guild);
        await replyNotice(
          interaction,
          closed.length ? "success" : "info",
          closed.length
            ? `Revealed the results of question ${closed.map((question) => `#${question.number}`).join(", ")}.`
            : "There are no multiple-choice or true/false questions waiting for results.",
        );
        return;
      }
    }
  },
};

export const questionsFeature: Feature = {
  name: "Questions",
  slashCommands: [questionCommand],
  components: [answerHandler, reviewHandler],
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
