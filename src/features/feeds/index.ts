import {
  ChannelType,
  escapeMarkdown,
  MessageFlags,
  PermissionFlagsBits,
  time,
  TimestampStyles,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { sendStaffLog } from "../../staff-log.js";
import type { AdminGroup, Feature } from "../../types.js";
import { embed, notice, plural, replyNotice, truncate } from "../../ui.js";
import { FeedError, parseFeed, type FeedItem, type ParsedFeed } from "./parse.js";
import {
  addFeed,
  allFeeds,
  getFeed,
  keywordList,
  listFeeds,
  markSeen,
  matchesKeywords,
  recordCheck,
  removeFeed,
  unseen,
  type Feed,
} from "./store.js";

const CHECK_EVERY_MS = 10 * 60_000;
const MAX_FEEDS_PER_SERVER = 15;
const MAX_POSTS_PER_CHECK = 5;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "TuliBot/1.0 (Discord community bot)";

/** Refuses addresses on the machine Tuli runs on or its private network. */
function isPrivateHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
    hostname.startsWith("[")
  );
}

function checkUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new FeedError("That isn't a valid link. It should start with https://");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new FeedError("Feed links have to start with https:// or http://");
  if (isPrivateHost(url.hostname)) throw new FeedError("Tuli can only read feeds from public websites.");
  return url;
}

export async function fetchFeed(input: string): Promise<ParsedFeed> {
  const url = checkUrl(input);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new FeedError("Tuli couldn't reach that website.");
  }
  if (!response.ok) throw new FeedError(`The website answered with an error (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FEED_BYTES) throw new FeedError("That feed is too big.");
  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) throw new FeedError("That feed is too big.");
  return parseFeed(xml);
}

function itemEmbed(feed: Pick<Feed, "title" | "url">, item: FeedItem) {
  const post = embed()
    .setAuthor({ name: truncate(feed.title, 256) })
    .setTitle(truncate(item.title, 256))
    .setDescription(item.summary ? truncate(item.summary, 350) : null)
    .setFooter({ text: new URL(feed.url).hostname.replace(/^www\./, "") });
  if (item.link?.startsWith("http")) post.setURL(item.link);
  if (item.imageUrl?.startsWith("http")) post.setImage(item.imageUrl);
  if (item.publishedAt) post.setTimestamp(item.publishedAt);
  return post;
}

function feedChannel(guild: Guild, feed: Feed): GuildTextBasedChannel | null {
  const channel = guild.channels.cache.get(feed.channel_id);
  return channel?.isTextBased() && !channel.isVoiceBased() ? channel : null;
}

/** Records a problem with a feed, telling staff when it first starts failing (not on every check). */
async function reportProblem(guild: Guild, feed: Feed, problem: string) {
  if (!feed.last_error) {
    await sendStaffLog(guild, { embeds: [notice("warning", `The **${escapeMarkdown(feed.title)}** feed stopped working: ${problem}`)] });
  }
  recordCheck(feed.id, problem);
}

/** Fetches one feed and shares any posts that are new since the last check. */
async function checkFeed(guild: Guild, feed: Feed): Promise<void> {
  const channel = feedChannel(guild, feed);
  if (!channel) return reportProblem(guild, feed, "Its channel was deleted. Remove it and add it again.");

  let parsed: ParsedFeed;
  try {
    parsed = await fetchFeed(feed.url);
  } catch (error) {
    return reportProblem(guild, feed, error instanceof FeedError ? error.message : "Something went wrong reading it.");
  }

  const fresh = new Set(unseen(feed.id, parsed.items.map((item) => item.key)));
  // Oldest first, and at most a few per check so a busy feed can't flood the channel.
  const toPost = parsed.items
    .filter((item) => fresh.has(item.key) && matchesKeywords(feed, item.title, item.summary))
    .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
    .slice(-MAX_POSTS_PER_CHECK);

  for (const [index, item] of toPost.entries()) {
    try {
      await channel.send({ embeds: [itemEmbed(feed, item)] });
    } catch (error) {
      console.error(`Couldn't post the ${feed.title} feed in ${guild.name}:`, error);
      // Leave the unposted items unseen so they're tried again next time.
      for (const unposted of toPost.slice(index)) fresh.delete(unposted.key);
      markSeen(feed.id, [...fresh]);
      return reportProblem(guild, feed, `Tuli couldn't post in ${channel}. Check its permissions there.`);
    }
  }
  // Everything else in the feed now counts as seen, including posts skipped by keywords.
  markSeen(feed.id, [...fresh]);
  recordCheck(feed.id, null);
}

function startPolling(client: Client<true>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const feed of allFeeds()) {
        const guild = client.guilds.cache.get(feed.guild_id);
        if (guild) await checkFeed(guild, feed);
      }
    } catch (error) {
      console.error("Feed check failed:", error);
    } finally {
      running = false;
    }
  };
  setInterval(tick, CHECK_EVERY_MS);
  void tick();
}

function feedLine(feed: Feed): string {
  const keywords = keywordList(feed);
  const status = feed.last_error ? `⚠️ ${feed.last_error}` : feed.last_checked_at ? `checked ${time(Math.floor(feed.last_checked_at / 1000), TimestampStyles.RelativeTime)}` : "not checked yet";
  return `**${escapeMarkdown(feed.title)}** → <#${feed.channel_id}>${keywords.length ? ` · only posts about: ${keywords.join(", ")}` : ""}\n-# ${feed.url} · ${status}`;
}

const feedsAdmin: AdminGroup = {
  name: "feeds",
  description: "Share posts from websites (RSS/Atom feeds) in a channel",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Post new items from a website's RSS or Atom feed in a channel")
          .addStringOption((o) => o.setName("url").setDescription("The feed link, e.g. https://www.news.iastate.edu/rss.xml").setRequired(true).setMaxLength(500))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Where to post").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) =>
            o.setName("keywords").setDescription("Only post items mentioning one of these, comma-separated (e.g. internship, scholarship)").setMaxLength(300),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("See the feeds Tuli is following"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Stop following a feed")
          .addStringOption((o) => o.setName("feed").setDescription("The feed").setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("preview")
          .setDescription("See the latest post from a feed, as Tuli would share it")
          .addStringOption((o) => o.setName("feed").setDescription("The feed").setRequired(true).setAutocomplete(true)),
      ),

  async execute(interaction) {
    const { guild } = interaction;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      const channel = interaction.options.getChannel("channel", true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      if (!channel.permissionsFor(interaction.client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        await replyNotice(interaction, "error", `Tuli can't post in ${channel}. Give it View Channel, Send Messages and Embed Links there.`);
        return;
      }
      if (listFeeds(guild.id).length >= MAX_FEEDS_PER_SERVER) {
        await replyNotice(interaction, "error", `A server can follow up to ${MAX_FEEDS_PER_SERVER} feeds. Remove one first.`);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const url = interaction.options.getString("url", true).trim();
      try {
        const parsed = await fetchFeed(url);
        const feed = addFeed(guild.id, {
          channelId: channel.id,
          url,
          title: truncate(parsed.title, 100),
          keywords: keywordList({ keywords: interaction.options.getString("keywords") ?? "" }).join(", "),
        });
        // Don't flood the channel with old posts: only posts from now on are shared.
        markSeen(feed.id, parsed.items.map((item) => item.key));
        recordCheck(feed.id, null);
        const latest = [...parsed.items].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
        await replyNotice(
          interaction,
          "success",
          `Following **${escapeMarkdown(feed.title)}**. New posts will appear in ${channel} (checked every 10 minutes).` +
            (latest ? "\nHere's how posts will look:" : "\nThe feed has no posts right now, so there's nothing to preview."),
          latest ? [itemEmbed(feed, latest)] : [],
        );
      } catch (error) {
        if (!(error instanceof FeedError)) throw error;
        await replyNotice(interaction, "error", error.message);
      }
      return;
    }

    if (subcommand === "list") {
      const feeds = listFeeds(guild.id);
      const list = embed()
        .setTitle(`📰 Feeds (${feeds.length})`)
        .setDescription(truncate(feeds.map(feedLine).join("\n\n") || "No feeds yet. Add one with `/admin feeds add`.", 4096));
      await interaction.reply({ embeds: [list], flags: MessageFlags.Ephemeral });
      return;
    }

    const feed = getFeed(guild.id, Number(interaction.options.getString("feed", true)));
    if (!feed) {
      await replyNotice(interaction, "error", "I couldn't find that feed. Pick one from the list as you type.");
      return;
    }
    if (subcommand === "remove") {
      removeFeed(guild.id, feed.id);
      await replyNotice(interaction, "success", `Stopped following **${escapeMarkdown(feed.title)}**.`);
      return;
    }

    // preview
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const parsed = await fetchFeed(feed.url);
      const latest = [...parsed.items].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
      if (!latest) await replyNotice(interaction, "info", "That feed has no posts right now.");
      else await replyNotice(interaction, "info", "The latest post, as Tuli would share it:", [itemEmbed(feed, latest)]);
    } catch (error) {
      if (!(error instanceof FeedError)) throw error;
      await replyNotice(interaction, "error", error.message);
    }
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const matches = listFeeds(interaction.guildId).filter((feed) => `${feed.title} ${feed.url}`.toLowerCase().includes(typed));
    await interaction.respond(
      matches.slice(0, 25).map((feed) => ({
        name: truncate(`${feed.title} → #${interaction.guild.channels.cache.get(feed.channel_id)?.name ?? "deleted channel"}`, 100),
        value: String(feed.id),
      })),
    );
  },
};

export const feedsFeature: Feature = {
  name: "Feeds",
  admin: feedsAdmin,
  onReady: startPolling,

  describeSettings(guild) {
    const feeds = listFeeds(guild.id);
    const broken = feeds.filter((feed) => feed.last_error);
    const lines = [feeds.length ? `Following ${plural(feeds.length, "feed")}` : "None yet. Add one with `/admin feeds add`."];
    for (const feed of broken) lines.push(`⚠️ **${escapeMarkdown(feed.title)}**: ${feed.last_error}`);
    return [{ name: "📰 Feeds", value: truncate(lines.join("\n"), 1024) }];
  },
};
