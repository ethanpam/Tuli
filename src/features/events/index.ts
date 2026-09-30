import {
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  time,
  TimestampStyles,
  type EmbedBuilder,
} from "discord.js";
import { getTimezone } from "../../settings.js";
import { friendlyDateTime, parseDateTime } from "../../time.js";
import type { AdminGroup, Feature } from "../../types.js";
import { embed, replyNotice, truncate } from "../../ui.js";
import { addEvent, findUpcomingEvents, getEvent, removeEvent, upcomingEvents, type Event } from "./store.js";

function eventLines(event: Event): string {
  const lines = [
    `### ${escapeMarkdown(event.title)}`,
    `🗓️ ${time(Math.floor(event.starts_at / 1000), TimestampStyles.LongDateShortTime)} · ${time(Math.floor(event.starts_at / 1000), TimestampStyles.RelativeTime)}`,
  ];
  if (event.location) lines.push(`📍 ${escapeMarkdown(event.location)}`);
  if (event.description) lines.push(`> ${escapeMarkdown(truncate(event.description, 300)).replace(/\n/g, "\n> ")}`);
  if (event.link) lines.push(`🔗 [More info](${event.link})`);
  return lines.join("\n");
}

function eventsEmbed(events: Event[]): EmbedBuilder {
  return embed()
    .setTitle("📅 Upcoming events")
    .setDescription(events.map(eventLines).join("\n\n"))
    .setFooter({ text: "Times are shown in your own timezone" });
}

const eventsAdmin: AdminGroup = {
  name: "events",
  description: "Upcoming events (Tuli can tell people about them too)",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add an event, like a GBM or social")
          .addStringOption((o) =>
            o.setName("title").setDescription("e.g. GBM #3: Mooncake Night").setRequired(true).setMaxLength(100),
          )
          .addStringOption((o) =>
            o.setName("date").setDescription("e.g. 10/15 or 2026-10-15").setRequired(true).setMaxLength(20),
          )
          .addStringOption((o) =>
            o.setName("time").setDescription("e.g. 6:30 PM (server timezone)").setRequired(true).setMaxLength(20),
          )
          .addStringOption((o) => o.setName("location").setDescription("Where it is").setMaxLength(100))
          .addStringOption((o) => o.setName("description").setDescription("What's happening").setMaxLength(500))
          .addStringOption((o) =>
            o.setName("link").setDescription("An RSVP form or more info (https://...)").setMaxLength(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove an upcoming event")
          .addStringOption((o) =>
            o.setName("event").setDescription("The event").setRequired(true).setAutocomplete(true),
          ),
      ),

  async execute(interaction) {
    const { guild } = interaction;
    const timezone = getTimezone(guild.id);

    if (interaction.options.getSubcommand() === "add") {
      const parsed = parseDateTime(
        interaction.options.getString("date", true),
        interaction.options.getString("time", true),
        timezone,
      );
      if ("problem" in parsed) {
        await replyNotice(interaction, "error", parsed.problem);
        return;
      }
      const link = interaction.options.getString("link")?.trim() ?? "";
      if (link && !/^https?:\/\//.test(link)) {
        await replyNotice(interaction, "error", "The link has to start with https://");
        return;
      }
      if (parsed.date.getTime() < Date.now()) {
        await replyNotice(
          interaction,
          "error",
          `That's in the past (${friendlyDateTime(parsed.date, timezone)}). Check the date?`,
        );
        return;
      }
      const event = addEvent(guild.id, {
        title: interaction.options.getString("title", true).trim(),
        starts_at: parsed.date.getTime(),
        location: interaction.options.getString("location")?.trim() ?? "",
        description: interaction.options.getString("description")?.trim() ?? "",
        link,
        created_by: interaction.user.id,
      });
      await replyNotice(
        interaction,
        "success",
        `Added **${escapeMarkdown(event.title)}** on ${friendlyDateTime(event.starts_at, timezone)} (${timezone}).`,
        [eventsEmbed([event])],
      );
      return;
    }

    // remove
    const event = getEvent(guild.id, Number(interaction.options.getString("event", true)));
    if (!event) {
      await replyNotice(interaction, "error", "I couldn't find that event. Pick one from the list as you type.");
      return;
    }
    removeEvent(guild.id, event.id);
    await replyNotice(interaction, "success", `Removed **${escapeMarkdown(event.title)}**.`);
  },

  async autocomplete(interaction) {
    const timezone = getTimezone(interaction.guildId);
    const events = findUpcomingEvents(interaction.guildId, interaction.options.getFocused());
    await interaction.respond(
      events.map((event) => ({
        name: truncate(`${event.title} · ${friendlyDateTime(event.starts_at, timezone)}`, 100),
        value: String(event.id),
      })),
    );
  },
};

export const eventsFeature: Feature = {
  name: "Events",
  admin: eventsAdmin,
  slashCommands: [
    {
      data: new SlashCommandBuilder()
        .setName("events")
        .setDescription("See what's coming up")
        .setContexts(InteractionContextType.Guild),
      async execute(interaction) {
        const events = upcomingEvents(interaction.guildId, 8);
        if (events.length === 0) {
          await replyNotice(interaction, "info", "Nothing's on the calendar yet. Check back soon!");
          return;
        }
        await interaction.reply({ embeds: [eventsEmbed(events)], flags: MessageFlags.Ephemeral });
      },
    },
  ],

  describeSettings(guild) {
    const [next] = upcomingEvents(guild.id, 1);
    const count = upcomingEvents(guild.id, 50).length;
    return [
      {
        name: "📅 Events",
        value: next
          ? `${count} upcoming · next: **${escapeMarkdown(next.title)}**, ${friendlyDateTime(next.starts_at, getTimezone(guild.id))}`
          : "None yet. Add one with `/admin events add`.",
      },
    ];
  },
};
