// Draws recorded messages the way Discord's dark theme shows them.
import type { APIEmbed } from "discord.js";
import type { Channel, ChatMessage, Person, Role } from "../../test/support/fake-discord.js";

export interface Directory {
  people: Map<string, Person>;
  roles: Map<string, Role>;
  channels: Map<string, Channel>;
  messages: ChatMessage[];
  timezone: string;
}

export interface Shot {
  channel: string;
  messages: ChatMessage[];
  /** A button or menu custom ID to draw as "about to be clicked". */
  highlight?: string;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function formatTime(ms: number, dir: Directory, style: string): string {
  const date = new Date(ms);
  const options: Record<string, Intl.DateTimeFormatOptions> = {
    t: { hour: "numeric", minute: "2-digit" },
    T: { hour: "numeric", minute: "2-digit", second: "2-digit" },
    d: { month: "2-digit", day: "2-digit", year: "numeric" },
    D: { month: "long", day: "numeric", year: "numeric" },
    f: { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
    F: { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
  };
  if (style === "R") {
    const seconds = Math.round((ms - Date.now()) / 1000);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    const format = new Intl.RelativeTimeFormat("en", { numeric: "always" });
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return seconds >= 0 ? "in a few seconds" : "a few seconds ago";
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: dir.timezone, ...options[style] }).format(date);
}

/** "Today at 9:00 AM", "Yesterday at 9:00 AM" or "9/21/26, 9:00 AM", like Discord's headers and footers. */
function clock(ms: number, dir: Directory): string {
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: dir.timezone }).format(new Date(at));
  const time = formatTime(ms, dir, "t");
  if (day(ms) === day(Date.now())) return `Today at ${time}`;
  if (day(ms) === day(Date.now() - 86_400_000)) return `Yesterday at ${time}`;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: dir.timezone,
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
  return `${date.format(new Date(ms))}, ${time}`;
}

/** Message text as a one-line preview: mentions become names and markdown symbols disappear. */
function preview(text: string, dir: Directory): string {
  return text
    .replace(/<@!?([\w-]+)>/g, (_, id: string) => `@${dir.people.get(id)?.name ?? "unknown"}`)
    .replace(/<@&([\w-]+)>/g, (_, id: string) => `@${dir.roles.get(id)?.name ?? "role"}`)
    .replace(/<#([\w-]+)>/g, (_, id: string) => `#${dir.channels.get(id)?.name ?? id}`)
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Discord's flavor of markdown: headings, subtext, quotes, bold, code, mentions, timestamps... */
export function markdown(text: string, dir: Directory): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = text;

  s = s.replace(/```(?:[a-z]*\n)?([\s\S]*?)```/g, (_, code: string) =>
    hold(`<pre>${escape(code.replace(/^\n|\n$/g, ""))}</pre>`),
  );
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escape(code)}</code>`));
  s = s.replace(/\\([*_~`|>#\-[\]()\\.])/g, (_, char: string) => hold(escape(char)));
  s = s.replace(/<@!?([\w-]+)>/g, (_, id: string) =>
    hold(`<span class="mention">@${escape(dir.people.get(id)?.name ?? "unknown")}</span>`),
  );
  s = s.replace(/<@&([\w-]+)>/g, (_, id: string) => {
    const role = dir.roles.get(id);
    const color = role?.color ?? "#c9cdfb";
    return hold(
      `<span class="mention" style="color:${color};background:${color}26">@${escape(role?.name ?? "role")}</span>`,
    );
  });
  s = s.replace(/@(everyone|here)\b/g, (mention: string) => hold(`<span class="mention">${mention}</span>`));
  s = s.replace(/<#([\w-]+)>/g, (_, id: string) =>
    hold(`<span class="mention">#${escape(dir.channels.get(id)?.name ?? id)}</span>`),
  );
  s = s.replace(/<\/([\w -]+):\d+>/g, (_, path: string) =>
    hold(`<span class="mention command">/${escape(path)}</span>`),
  );
  s = s.replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_, unix: string, style = "f") =>
    hold(`<span class="timestamp">${escape(formatTime(Number(unix) * 1000, dir, style))}</span>`),
  );
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string) => hold(`<a>${escape(label)}</a>`));
  s = s.replace(/https?:\/\/[^\s<]+/g, (url) => hold(`<a>${escape(url)}</a>`));

  s = escape(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>");

  const blocks: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) blocks.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
    quote = [];
  };
  for (const line of s.split("\n")) {
    if (line.startsWith("&gt; ")) {
      quote.push(line.slice(5));
      continue;
    }
    flushQuote();
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) blocks.push(`<div class="h${heading[1]!.length}">${heading[2]}</div>`);
    else if (line.startsWith("-# ")) blocks.push(`<div class="subtext">${line.slice(3)}</div>`);
    else blocks.push(`<div class="line">${line || "&nbsp;"}</div>`);
  }
  flushQuote();

  let html = blocks.join("");
  while (html.includes("\u0000")) html = html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? "");
  return html;
}

/** Swaps the pretend CDN avatar links for the drawn avatars. */
function image(url: string, dir: Directory): string {
  const id = /cdn\.discordapp\.com\/avatars\/([\w-]+)\//.exec(url)?.[1];
  return (id && dir.people.get(id)?.avatar) || url;
}

function embedHtml(embed: APIEmbed, dir: Directory): string {
  const color = embed.color === undefined ? "#1e1f22" : `#${embed.color.toString(16).padStart(6, "0")}`;
  const parts: string[] = [];
  if (embed.author) {
    const icon = embed.author.icon_url ? `<img src="${image(embed.author.icon_url, dir)}">` : "";
    parts.push(`<div class="e-author">${icon}<span>${escape(embed.author.name)}</span></div>`);
  }
  if (embed.title) parts.push(`<div class="e-title${embed.url ? " link" : ""}">${markdown(embed.title, dir)}</div>`);
  if (embed.description) parts.push(`<div class="e-desc">${markdown(embed.description, dir)}</div>`);
  if (embed.fields?.length) {
    const fields = embed.fields
      .map(
        (field) =>
          `<div class="e-field${field.inline ? " inline" : ""}"><div class="e-field-name">${markdown(field.name, dir)}</div><div class="e-field-value">${markdown(field.value, dir)}</div></div>`,
      )
      .join("");
    parts.push(`<div class="e-fields">${fields}</div>`);
  }
  const thumbnail = embed.thumbnail?.url ? `<img class="e-thumb" src="${image(embed.thumbnail.url, dir)}">` : "";
  const picture = embed.image?.url ? `<img class="e-image" src="${image(embed.image.url, dir)}">` : "";
  const footerText = [
    embed.footer?.text ? escape(embed.footer.text) : "",
    embed.timestamp ? clock(Date.parse(embed.timestamp), dir) : "",
  ]
    .filter(Boolean)
    .join(" • ");
  const footer = footerText ? `<div class="e-footer">${footerText}</div>` : "";
  return `<div class="embed" style="border-left-color:${color}"><div class="e-grid"><div class="e-main">${parts.join("")}</div>${thumbnail}</div>${picture}${footer}</div>`;
}

interface ComponentJson {
  type: number;
  style?: number;
  label?: string;
  emoji?: { name?: string };
  disabled?: boolean;
  custom_id?: string;
  placeholder?: string;
  components?: ComponentJson[];
}

const BUTTON_STYLES = ["", "primary", "secondary", "success", "danger", "secondary"];

function componentsHtml(rows: unknown[], highlight?: string): string {
  const html = (rows as ComponentJson[]).map((row) => {
    const items = (row.components ?? []).map((c) => {
      const lit = c.custom_id && c.custom_id === highlight ? " highlight" : "";
      if (c.type === 2) {
        const style = BUTTON_STYLES[c.style ?? 2];
        const link = c.style === 5 ? `<span class="ext">↗</span>` : "";
        return `<div class="button ${style}${c.disabled ? " disabled" : ""}${lit}">${escape(c.label ?? "")}${link}</div>`;
      }
      return `<div class="select${lit}"><span>${escape(c.placeholder ?? "Make a selection")}</span><span class="chevron">⌄</span></div>`;
    });
    return `<div class="row">${items.join("")}</div>`;
  });
  return rows.length ? `<div class="components">${html.join("")}</div>` : "";
}

function messageHtml(message: ChatMessage, dir: Directory, highlight?: string): string {
  const header: string[] = [];
  if (message.usedCommand) {
    const { by, name } = message.usedCommand;
    header.push(
      `<div class="pre"><span class="spine"></span><img src="${by.avatar}"><span class="pre-name" style="color:${by.color}">${escape(by.name)}</span> used <span class="cmd">${escape(name)}</span></div>`,
    );
  } else if (message.replyTo) {
    const original = dir.messages.find((m) => m.id === message.replyTo);
    if (original) {
      const excerpt = original.content
        ? preview(original.content, dir)
        : original.embeds[0]
          ? "Click to see attachment"
          : "";
      header.push(
        `<div class="pre"><span class="spine"></span><img src="${original.author.avatar}"><span class="pre-name" style="color:${original.author.color}">@${escape(original.author.name)}</span> <span class="excerpt">${escape(excerpt.slice(0, 80))}</span></div>`,
      );
    }
  }
  const author = message.author;
  const badge = author.bot ? `<span class="app">APP</span>` : "";
  const content = message.content ? `<div class="content">${markdown(message.content, dir)}</div>` : "";
  const embeds = message.embeds.map((embed) => embedHtml(embed, dir)).join("");
  const thread = message.thread
    ? `<div class="thread"><div class="thread-name">${escape(message.thread.name)}</div><div class="thread-meta">${message.thread.messages} ${message.thread.messages === 1 ? "Message" : "Messages"} ›</div></div>`
    : "";
  const reactions = message.reactions.length
    ? `<div class="reactions">${[...new Set(message.reactions)].map((emoji) => `<span class="reaction">${emoji}<b>${message.reactions.filter((r) => r === emoji).length}</b></span>`).join("")}</div>`
    : "";
  const ephemeral = message.ephemeral
    ? `<div class="ephemeral">👁️ Only you can see this · <a>Dismiss message</a></div>`
    : "";
  return `<div class="msg">${header.join("")}<div class="msg-row"><img class="avatar" src="${author.avatar}"><div class="msg-body">
    <div class="meta"><span class="name" style="color:${author.color}">${escape(author.name)}</span>${badge}<span class="time">${clock(message.time, dir)}</span></div>
    ${content}${embeds}${componentsHtml(message.components, highlight)}${thread}${reactions}${ephemeral}
  </div></div></div>`;
}

const STYLES = `
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; }
  .stage { display: inline-block; padding: 28px; }
  .window { width: 780px; background: #313338; border-radius: 12px; overflow: hidden; color: #dbdee1;
    font-family: "Noto Sans", -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 16px; line-height: 1.375;
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 50px rgba(0,0,0,.35); display: flex; flex-direction: column; }
  .flat .stage { padding: 0; } .flat .window { border-radius: 0; box-shadow: none; }
  /* Animation frames share one height; start at the top so new messages appear below. */
  .flat .messages { justify-content: flex-start; }
  .bar { height: 48px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #26272b; }
  .bar .hash { color: #80848e; font-size: 24px; font-weight: 400; }
  .bar .title { color: #f2f3f5; font-weight: 600; }
  .bar .topic { color: #949ba4; font-size: 14px; border-left: 1px solid #3f4147; padding-left: 12px; margin-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .messages { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding: 4px 0 18px; }
  .msg { padding: 2px 18px 2px 16px; margin-top: 14px; }
  .msg-row { display: flex; gap: 16px; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
  .msg-body { min-width: 0; flex: 1; }
  .meta { display: flex; align-items: center; gap: 6px; height: 22px; }
  .name { font-weight: 600; }
  .app { background: #5865f2; color: #fff; font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 4px; line-height: 16px; height: 16px; }
  .time { color: #949ba4; font-size: 12px; margin-left: 2px; }
  .pre { display: flex; align-items: center; gap: 4px; font-size: 14px; color: #b5bac1; margin: 0 0 4px 36px; position: relative; height: 20px; }
  .pre img { width: 16px; height: 16px; border-radius: 50%; }
  .pre .spine { position: absolute; left: -18px; top: 9px; width: 30px; height: 12px; border-left: 2px solid #4e5058; border-top: 2px solid #4e5058; border-top-left-radius: 6px; }
  .pre-name { font-weight: 600; }
  .pre .cmd { color: #00a8fc; }
  .excerpt { color: #b5bac1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
  .line { min-height: 22px; white-space: pre-wrap; word-wrap: break-word; }
  .h1 { font-size: 24px; font-weight: 700; color: #f2f3f5; margin: 8px 0 4px; line-height: 1.3; }
  .h2 { font-size: 20px; font-weight: 700; color: #f2f3f5; margin: 8px 0 4px; line-height: 1.3; }
  .h3 { font-size: 16px; font-weight: 700; color: #f2f3f5; margin: 8px 0 4px; }
  .subtext { font-size: 12px; color: #949ba4; }
  blockquote { margin: 2px 0; padding: 0 0 0 12px; border-left: 4px solid #4e5058; }
  strong { font-weight: 700; color: inherit; }
  code { font-family: Menlo, Consolas, monospace; font-size: 85%; background: #2b2d31; border: 1px solid #1e1f22; border-radius: 4px; padding: 1px 3px; }
  pre { font-family: Menlo, Consolas, monospace; font-size: 13px; background: #2b2d31; border: 1px solid #1e1f22; border-radius: 4px; padding: 7px; margin: 4px 0; white-space: pre-wrap; }
  a { color: #00a8fc; }
  .mention { background: rgba(88,101,242,.3); color: #c9cdfb; border-radius: 3px; padding: 0 2px; font-weight: 500; }
  .mention.command { background: rgba(88,101,242,.3); }
  .timestamp { background: rgba(255,255,255,.06); border-radius: 3px; padding: 0 2px; }
  .embed { background: #2b2d31; border-left: 4px solid; border-radius: 4px; max-width: 540px; padding: 8px 16px 16px 12px; margin-top: 6px; font-size: 14px; }
  .e-grid { display: flex; gap: 16px; }
  .e-main { flex: 1; min-width: 0; }
  .e-author { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-weight: 600; color: #f2f3f5; font-size: 14px; }
  .e-author img { width: 24px; height: 24px; border-radius: 50%; }
  .e-title { margin-top: 8px; font-weight: 700; color: #f2f3f5; font-size: 16px; }
  .e-title.link { color: #00a8fc; }
  .e-desc { margin-top: 8px; }
  .e-desc .line, .e-field-value .line { min-height: 18px; }
  .e-fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; margin-top: 8px; }
  .e-field { grid-column: 1 / -1; }
  .e-field.inline { grid-column: auto; }
  .e-field-name { font-weight: 600; color: #f2f3f5; margin-bottom: 2px; }
  .e-thumb { width: 80px; height: 80px; border-radius: 4px; margin-top: 8px; object-fit: cover; }
  .e-image { max-width: 100%; border-radius: 4px; margin-top: 16px; display: block; }
  .e-footer { margin-top: 8px; font-size: 12px; color: #b5bac1; }
  .components { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .button { height: 32px; min-width: 60px; padding: 0 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; color: #fff; font-size: 14px; font-weight: 500; white-space: nowrap; }
  .button.primary { background: #5865f2; } .button.secondary { background: #4e5058; }
  .button.success { background: #248046; } .button.danger { background: #da373c; }
  .button.disabled { opacity: .5; }
  .ext { font-size: 12px; }
  .select { width: 420px; height: 40px; background: #1e1f22; border: 1px solid #1e1f22; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; color: #949ba4; font-size: 15px; }
  .chevron { font-size: 20px; line-height: 1; margin-top: -8px; }
  .highlight { outline: 3px solid #fff; outline-offset: 2px; transform: scale(1.04); box-shadow: 0 0 22px rgba(255,255,255,.35); }
  .thread { margin-top: 8px; background: #2b2d31; border-radius: 8px; padding: 8px 12px; max-width: 480px; }
  .thread-name { font-weight: 600; color: #f2f3f5; font-size: 14px; }
  .thread-meta { color: #00a8fc; font-size: 13px; font-weight: 600; margin-top: 2px; }
  .reactions { display: flex; gap: 4px; margin-top: 6px; }
  .reaction { display: inline-flex; align-items: center; gap: 6px; background: rgba(88,101,242,.15); border: 1px solid #5865f2; border-radius: 8px; padding: 1px 8px; font-size: 14px; }
  .reaction b { color: #c9cdfb; font-weight: 600; font-size: 13px; }
  .ephemeral { margin-top: 6px; font-size: 12px; color: #949ba4; }
`;

/** A full HTML page showing one channel with its messages. */
export function shotPage(shot: Shot, dir: Directory, { flat = false, minHeight = 0 } = {}): string {
  const channel = dir.channels.get(shot.channel);
  const isDm = shot.channel.startsWith("dm-");
  const bar = isDm
    ? `<span class="hash">@</span><span class="title">Tuli</span>`
    : `<span class="hash">#</span><span class="title">${escape(channel?.name ?? shot.channel)}</span>${channel?.topic ? `<span class="topic">${escape(channel.topic)}</span>` : ""}`;
  const messages = shot.messages.map((message) => messageHtml(message, dir, shot.highlight)).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=block" rel="stylesheet">
  <style>${STYLES}</style></head>
  <body class="${flat ? "flat" : ""}"><div class="stage" id="shot"><div class="window" style="min-height:${minHeight}px">
  <div class="bar">${bar}</div><div class="messages">${messages}</div></div></div></body></html>`;
}
