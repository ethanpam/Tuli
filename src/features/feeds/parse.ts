import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  /** Stable ID used to remember which posts were already shared. */
  key: string;
  title: string;
  link: string | null;
  summary: string;
  publishedAt: number | null;
  imageUrl: string | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

export class FeedError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link", "enclosure", "media:content", "media:thumbnail"].includes(name),
});

type Node = Record<string, unknown>;

/** The text inside an element, whether it's plain, has attributes, or is missing. */
function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object" && "#text" in value) return text((value as Node)["#text"]);
  return "";
}

function attribute(value: unknown, name: string): string {
  return value && typeof value === "object" ? text((value as Node)[`@_${name}`]) : "";
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Turns a post's HTML description into readable plain text. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/The post .+ appeared first on .+\.?\s*$/s, "") // WordPress footer
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function firstImage(html: string): string | null {
  return /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
}

function dateOf(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Date.parse(text(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mediaImage(node: Node): string | null {
  const candidates = [
    ...((node["enclosure"] as unknown[]) ?? []).filter((e) => attribute(e, "type").startsWith("image/")),
    ...((node["media:content"] as unknown[]) ?? []).filter(
      (m) => attribute(m, "medium") === "image" || attribute(m, "type").startsWith("image/"),
    ),
    ...((node["media:thumbnail"] as unknown[]) ?? []),
  ];
  return candidates.map((c) => attribute(c, "url")).find(Boolean) ?? null;
}

function rssItem(item: Node): FeedItem {
  const html = text(item["content:encoded"]) || text(item["description"]);
  const link = text(item["link"]) || null;
  const title = htmlToText(text(item["title"])) || "Untitled";
  return {
    key: text(item["guid"]) || link || title,
    title,
    link,
    summary: htmlToText(text(item["description"]) || html),
    publishedAt: dateOf(item["pubDate"], item["dc:date"]),
    imageUrl: mediaImage(item) ?? firstImage(html),
  };
}

function atomEntry(entry: Node): FeedItem {
  const links = (entry["link"] as unknown[]) ?? [];
  const link = links.find((l) => ["", "alternate"].includes(attribute(l, "rel"))) ?? links[0];
  const html = text(entry["content"]) || text(entry["summary"]);
  const url = attribute(link, "href") || null;
  const title = htmlToText(text(entry["title"])) || "Untitled";
  return {
    key: text(entry["id"]) || url || title,
    title,
    link: url,
    summary: htmlToText(text(entry["summary"]) || html),
    publishedAt: dateOf(entry["published"], entry["updated"]),
    imageUrl: mediaImage(entry) ?? firstImage(html),
  };
}

/** Reads an RSS 2.0, RSS 1.0 or Atom feed. Throws FeedError if it isn't one. */
export function parseFeed(xml: string): ParsedFeed {
  let document: Node;
  try {
    document = parser.parse(xml) as Node;
  } catch {
    throw new FeedError("That page isn't valid XML, so it's not an RSS or Atom feed.");
  }
  const rss = document["rss"] as Node | undefined;
  const channel = rss?.["channel"] as Node | undefined;
  if (channel) {
    return { title: text(channel["title"]) || "RSS feed", items: ((channel["item"] as Node[]) ?? []).map(rssItem) };
  }
  const atom = document["feed"] as Node | undefined;
  if (atom) {
    return { title: text(atom["title"]) || "Atom feed", items: ((atom["entry"] as Node[]) ?? []).map(atomEntry) };
  }
  const rdf = document["rdf:RDF"] as Node | undefined;
  if (rdf) {
    const rdfChannel = rdf["channel"] as Node | undefined;
    return { title: text(rdfChannel?.["title"]) || "RSS feed", items: ((rdf["item"] as Node[]) ?? []).map(rssItem) };
  }
  throw new FeedError(
    "That page isn't an RSS or Atom feed. Look for an RSS link on the site (often /feed/ or /rss.xml).",
  );
}
