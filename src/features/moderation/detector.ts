// Spots the scams that hit community servers: fake Discord/Steam links, "free Nitro"
// bait, compromised accounts blasting one message into every channel, and the classic
// "giving away my MacBook, DM me" post. Pure logic, so it's easy to test.

export interface Verdict {
  /** "block" = delete and time out right away; "flag" = ask staff to take a look. */
  action: "block" | "flag";
  reasons: string[];
}

// Real domains. Anything that looks like these but isn't one of them is a phishing site.
const OFFICIAL_DOMAINS = [
  "discord.com",
  "discord.gg",
  "discord.gift",
  "discord.new",
  "discord.media",
  "discordapp.com",
  "discordapp.net",
  "discordstatus.com",
  "discord.co",
  "steamcommunity.com",
  "steampowered.com",
  "steamstatic.com",
  "steamgames.com",
  "steam.tv",
];
const IMPERSONATED = ["discord", "discordapp", "discordnitro", "steamcommunity", "steampowered"];

const URL_PATTERN = /\bhttps?:\/\/([^\s/?#<>]+)/gi;

export function linkDomains(content: string): string[] {
  return [...content.matchAll(URL_PATTERN)].map((match) => (match[1] ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^www\./, ""));
}

function isOfficial(host: string): boolean {
  return OFFICIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Undoes common letter swaps: "dlsc0rd" → "discord", "stearncommunity" → "steamcommunity". */
function unLeet(text: string): string {
  return text.replace(/rn/g, "m").replace(/vv/g, "w").replace(/0/g, "o").replace(/[1l|]/g, "i").replace(/3/g, "e").replace(/5/g, "s").replace(/[^a-z]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** A domain pretending to be Discord or Steam, like "dlscord.gift" or "steamcommunlty.ru". */
export function isLookalikeDomain(host: string): boolean {
  if (isOfficial(host)) return false;
  const imitated = IMPERSONATED.map(unLeet);
  return host.split(".").some((label) => {
    const plain = unLeet(label);
    if (plain.length < 5) return false;
    return imitated.some((name) => plain.includes(name) || editDistance(plain, name) <= 2);
  });
}

const GIFT_BAIT = /\b(free|gift|claim|giveaway|airdrop)\b[\s\S]{0,40}\b(nitro|steam)\b|\b(nitro|steam)\b[\s\S]{0,40}\b(free|gift|claim|giveaway|airdrop)\b/i;
const MASS_PING = /@(everyone|here)\b/;
const GIVEAWAY_BAIT =
  /\b(giving away|give away|giveaway|selling|for free)\b[^\n]{0,80}\b(mac ?book|laptop|i ?pad|iphone|ps5|playstation|xbox|nintendo switch|airpods|tickets?|gpu|graphics card|monitor|camera)\b/i;
const CONTACT_ME = /\b(dm|dms|message me|text me|hmu|first come|interested)\b/i;

export interface MessageFacts {
  content: string;
  /** Whether the author is allowed to ping @everyone (if not, "@everyone" in a message is a red flag). */
  canMentionEveryone: boolean;
}

/** Checks one message on its own. Returns null if it looks fine. */
export function checkMessage({ content, canMentionEveryone }: MessageFacts): Verdict | null {
  const domains = linkDomains(content);
  const block: string[] = [];

  const fakes = [...new Set(domains.filter(isLookalikeDomain))];
  if (fakes.length) block.push(`Links to a fake Discord/Steam site (${fakes.join(", ")})`);
  if (domains.length && GIFT_BAIT.test(content)) block.push("Free Nitro/Steam gift bait with a link");
  if (domains.length && !canMentionEveryone && MASS_PING.test(content)) block.push("Tried to ping @everyone with a link");
  if (block.length) return { action: "block", reasons: block };

  if (GIVEAWAY_BAIT.test(content) && CONTACT_ME.test(content)) {
    return { action: "flag", reasons: ['Looks like a "giving away my ..., DM me" scam, often posted by hacked accounts'] };
  }
  return null;
}

interface RecentMessage {
  channelId: string;
  messageId: string;
  key: string;
  at: number;
}

/**
 * Remembers each person's recent messages to catch the same message being posted in
 * several channels at once, which is how hacked accounts spread scams.
 */
export class RepeatTracker {
  private recent = new Map<string, RecentMessage[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly channelLimit = 3,
  ) {}

  /** Records a message. Returns every copy (including this one) if it's now in too many channels. */
  record(guildId: string, userId: string, message: RecentMessage): RecentMessage[] | null {
    const who = `${guildId}:${userId}`;
    const fresh = (this.recent.get(who) ?? []).filter((m) => message.at - m.at <= this.windowMs);
    fresh.push(message);
    this.recent.set(who, fresh);

    const copies = fresh.filter((m) => m.key === message.key);
    if (new Set(copies.map((m) => m.channelId)).size < this.channelLimit) return null;
    this.recent.set(who, fresh.filter((m) => m.key !== message.key)); // report each burst once
    return copies;
  }

  /** Drops people who haven't posted recently, so memory doesn't grow forever. */
  sweep(now: number): void {
    for (const [who, messages] of this.recent) {
      if (messages.every((m) => now - m.at > this.windowMs)) this.recent.delete(who);
    }
  }
}

/** What counts as "the same message": same text ignoring case/spacing, or the same attachments. */
export function repeatKey(content: string, attachments: string[]): string | null {
  const text = content.toLowerCase().replace(/\s+/g, " ").trim();
  if (text.length >= 8 || linkDomains(content).length) return `text:${text}`;
  if (attachments.length) return `files:${attachments.sort().join("|")}`;
  return null; // too short to judge ("lol", "ok")
}
