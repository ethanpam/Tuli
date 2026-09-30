// A pretend Discord server for making the README's screenshots. Tuli's real router and
// features run against it unchanged, and every message they send is recorded so it can be
// drawn. Only the parts of discord.js that Tuli actually touches are imitated.
import {
  Collection,
  MessageFlags,
  PermissionsBitField,
  type APIEmbed,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { createRouter } from "../../src/router.js";
import type { Feature } from "../../src/types.js";

export interface Person {
  id: string;
  name: string;
  /** Name color (from their top role). */
  color: string;
  avatar: string;
  bot?: boolean;
  staff?: boolean;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  author: Person;
  content?: string;
  embeds: APIEmbed[];
  components: unknown[];
  time: number;
  ephemeral?: boolean;
  /** For ephemeral messages: the only person who can see it. */
  visibleTo?: string;
  /** "Alex used /points daily" above an interaction reply. */
  usedCommand?: { by: Person; name: string };
  replyTo?: string;
  reactions: string[];
  thread?: { name: string; messages: number };
  deleted?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  topic?: string;
}

export interface Role {
  id: string;
  name: string;
  color: string;
}

/** The parts of a discord.js Guild that Tuli uses. */
interface FakeGuild {
  id: string;
  name: string;
  client: unknown;
  iconURL(): null;
  channels: { cache: Collection<string, unknown> };
  roles: { cache: Collection<string, unknown> };
  members: { me: unknown; fetch(id: string): Promise<unknown>; ban(): Promise<void> };
}

type Options = Record<string, string | number | boolean | Person | { role: string } | { channel: string }>;

/** Discord only accepts http(s) image links, so people get CDN-style avatar URLs (drawn from their avatar). */
export function avatarUrl(person: Person): string {
  return `https://cdn.discordapp.com/avatars/${person.id}/avatar.png`;
}

const json = (value: unknown) =>
  value && typeof value === "object" && "toJSON" in value ? (value as { toJSON(): unknown }).toJSON() : value;

function isEphemeral(payload: unknown): boolean {
  const flags = (payload as { flags?: unknown } | undefined)?.flags;
  return typeof flags === "number" && (flags & MessageFlags.Ephemeral) !== 0;
}

export class World {
  readonly messages: ChatMessage[] = [];
  readonly channels = new Map<string, Channel>();
  readonly roles = new Map<string, Role>();
  readonly people = new Map<string, Person>();
  readonly router;
  readonly guild: FakeGuild;
  readonly client;
  private nextId = 1000;
  private readonly roleCache = new Collection<string, unknown>();

  constructor(
    readonly tuli: Person,
    readonly guildName: string,
    features: Feature[],
  ) {
    this.people.set(tuli.id, tuli);
    this.router = createRouter(features);
    const commands = new Collection<string, unknown>();
    for (const data of this.router.commandData() as (RESTPostAPIApplicationCommandsJSONBody &
      Record<string, unknown>)[]) {
      const id = String(9000 + commands.size);
      const permissions = data.default_member_permissions;
      commands.set(id, {
        ...data,
        id,
        type: data.type ?? 1,
        options: data.options ?? [],
        defaultMemberPermissions: permissions ? new PermissionsBitField(BigInt(permissions as string)) : null,
      });
    }
    this.client = {
      user: this.user(tuli),
      application: { commands: { cache: commands } },
      options: { intents: { has: () => true } },
    };
    this.guild = {
      id: "guild",
      name: guildName,
      client: this.client,
      iconURL: () => null,
      channels: { cache: new Collection<string, unknown>() },
      roles: { cache: this.roleCache },
      members: {
        me: this.member(tuli),
        fetch: async (id: string) => {
          const person = this.people.get(id);
          if (!person) throw new Error("Unknown member");
          return this.member(person);
        },
        ban: async () => {},
      },
    };
  }

  // ─── Setting the scene ─────────────────────────────────────────────────────

  addPerson(person: Person): Person {
    this.people.set(person.id, person);
    return person;
  }

  addChannel(channel: Channel): Channel {
    this.channels.set(channel.id, channel);
    this.guild.channels.cache.set(channel.id, this.channel(channel.id));
    return channel;
  }

  addRole(role: Role): Role {
    this.roles.set(role.id, role);
    this.roleCache.set(role.id, {
      ...role,
      guild: this.guild,
      managed: false,
      mentionable: true,
      permissions: { any: () => false },
      comparePositionTo: () => -1,
      toString: () => `<@&${role.id}>`,
    });
    return role;
  }

  // ─── Doing things ──────────────────────────────────────────────────────────

  /** Someone sends a message; Tuli sees it like any other. */
  async say(person: Person, channelId: string, content: string, { mentionsTuli = false } = {}): Promise<ChatMessage> {
    const record = this.post(channelId, person, { content });
    await this.deliver(record, { mentionsTuli });
    return record;
  }

  /** Lets Tuli see a message that was already posted (so a screenshot can be taken in between). */
  async deliver(record: ChatMessage, { mentionsTuli = false } = {}): Promise<void> {
    const parent = record.channelId.startsWith("thread-")
      ? this.messages.find((m) => m.id === record.channelId.slice("thread-".length))
      : undefined;
    if (parent?.thread) parent.thread.messages++;
    const message = this.message(record);
    message.mentions.has = () => mentionsTuli;
    await this.router.handleMessage(message as never);
  }

  /** Someone runs a slash command, e.g. command(alex, "general", "points daily"). */
  async command(person: Person, channelId: string, path: string, options: Options = {}): Promise<void> {
    const [name = "", ...rest] = path.split(" ");
    const [group, sub] = rest.length === 2 ? rest : [null, rest[0] ?? null];
    await this.router.handleInteraction(
      this.interaction("command", person, channelId, {
        commandName: name,
        usedName: `/${path}`,
        options: this.options(options, sub, group),
      }) as never,
    );
  }

  /** Someone uses a right-click → Apps command on a message. */
  async contextMenu(person: Person, name: string, target: ChatMessage): Promise<void> {
    await this.router.handleInteraction(
      this.interaction("context", person, target.channelId, {
        commandName: name,
        usedName: name,
        targetMessage: this.message(target),
      }) as never,
    );
  }

  /** Someone clicks a button (or picks from a menu) on a message. */
  async click(person: Person, target: ChatMessage, customId: string, values?: string[]): Promise<void> {
    await this.router.handleInteraction(
      this.interaction("component", person, target.channelId, {
        customId,
        values,
        message: this.message(target),
        target,
      }) as never,
    );
  }

  /** The last `count` messages in a channel as `viewer` sees them right now. */
  snapshot(channelId: string, { count = 50, viewer = "" } = {}): ChatMessage[] {
    const visible = this.messages.filter(
      (m) => m.channelId === channelId && !m.deleted && (!m.visibleTo || m.visibleTo === viewer),
    );
    return structuredClone(visible.slice(-count));
  }

  latest(channelId: string, predicate: (message: ChatMessage) => boolean = () => true): ChatMessage {
    const found = this.messages.filter((m) => m.channelId === channelId && predicate(m)).at(-1);
    if (!found) throw new Error(`No matching message in #${channelId}`);
    return found;
  }

  // ─── Recording ─────────────────────────────────────────────────────────────

  post(channelId: string, author: Person, payload: unknown, extra: Partial<ChatMessage> = {}): ChatMessage {
    const record: ChatMessage = {
      id: String(this.nextId++),
      channelId,
      author,
      embeds: [],
      components: [],
      reactions: [],
      time: Date.now(),
      ...extra,
    };
    this.apply(record, payload);
    this.messages.push(record);
    return record;
  }

  /** Changes a message the way Discord does: only the parts that were sent are replaced. */
  private apply(record: ChatMessage, payload: unknown) {
    if (typeof payload === "string") {
      record.content = payload;
      return;
    }
    const p = (payload ?? {}) as { content?: string; embeds?: unknown[]; components?: unknown[] };
    if ("content" in p) record.content = p.content ?? undefined;
    if (p.embeds) record.embeds = p.embeds.map(json) as APIEmbed[];
    if (p.components) record.components = p.components.map(json);
  }

  // ─── Imitations of discord.js objects ──────────────────────────────────────

  user(person: Person) {
    return {
      id: person.id,
      username: person.name.toLowerCase(),
      displayName: person.name,
      bot: !!person.bot,
      tag: person.name.toLowerCase(),
      createdAt: new Date(Date.now() - (person.id === "riley" ? 40 : 900) * 24 * 60 * 60 * 1000),
      displayAvatarURL: () => avatarUrl(person),
      toString: () => `<@${person.id}>`,
      send: async (payload: unknown) => this.post(`dm-${person.id}`, this.tuli, payload),
    };
  }

  member(person: Person) {
    const roles = new Collection<string, unknown>();
    return {
      id: person.id,
      user: this.user(person),
      guild: this.guild,
      displayName: person.name,
      displayAvatarURL: () => avatarUrl(person),
      joinedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      moderatable: true,
      permissions: { has: () => !!person.staff || !!person.bot },
      roles: {
        cache: roles,
        highest: { name: person.name, comparePositionTo: () => 1 },
        botRole: null,
        add: async (role: { id: string }) => void roles.set(role.id, role),
      },
      timeout: async () => {},
      send: async (payload: unknown) => this.post(`dm-${person.id}`, this.tuli, payload),
      toString: () => `<@${person.id}>`,
    };
  }

  channel(channelId: string) {
    const channel = this.channels.get(channelId);
    return {
      id: channelId,
      name: channel?.name ?? channelId,
      toString: () => `<#${channelId}>`,
      isTextBased: () => true,
      isThread: () => channelId.startsWith("thread-"),
      isVoiceBased: () => false,
      isSendable: () => true,
      isDMBased: () => false,
      permissionsFor: (who: { id: string } | null) => ({
        has: () => who?.id === this.tuli.id || !!this.people.get(who?.id ?? "")?.staff,
      }),
      send: async (payload: unknown) => this.message(this.post(channelId, this.tuli, payload)),
      messages: {
        fetch: async (id: string) => {
          const record = this.messages.find((m) => m.id === id && !m.deleted);
          if (!record) throw new Error("Unknown message");
          return this.message(record);
        },
        delete: async (id: string) => {
          const record = this.messages.find((m) => m.id === id);
          if (record) record.deleted = true;
        },
      },
    };
  }

  message(record: ChatMessage) {
    return {
      id: record.id,
      channelId: record.channelId,
      guildId: this.guild.id,
      guild: this.guild,
      client: this.client,
      channel: this.channel(record.channelId),
      author: this.user(record.author),
      member: this.member(record.author),
      get content() {
        return record.content ?? "";
      },
      get embeds() {
        return record.embeds;
      },
      createdTimestamp: record.time,
      url: `https://discord.com/channels/${this.guild.id}/${record.channelId}/${record.id}`,
      attachments: new Collection(),
      system: false,
      inGuild: () => true,
      mentions: { has: (_: unknown) => false, roles: { has: () => false } },
      edit: async (payload: unknown) => this.apply(record, payload),
      reply: async (payload: unknown) =>
        this.message(this.post(record.channelId, this.tuli, payload, { replyTo: record.id })),
      react: async (emoji: string) => void record.reactions.push(emoji),
      startThread: async ({ name }: { name: string }) => {
        record.thread = { name, messages: 0 };
        this.addChannel({ id: `thread-${record.id}`, name });
        return this.channel(`thread-${record.id}`);
      },
    };
  }

  private options(values: Options, sub: string | null, group: string | null) {
    const raw = (name: string) => values[name];
    const person = (name: string) => {
      const value = raw(name);
      return value && typeof value === "object" && "avatar" in value ? value : null;
    };
    return {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group,
      getString: (name: string) => (typeof raw(name) === "string" ? (raw(name) as string) : null),
      getInteger: (name: string) => (typeof raw(name) === "number" ? (raw(name) as number) : null),
      getBoolean: (name: string) => (typeof raw(name) === "boolean" ? (raw(name) as boolean) : null),
      getUser: (name: string) => (person(name) ? this.user(person(name)!) : null),
      getMember: (name: string) => (person(name) ? this.member(person(name)!) : null),
      getRole: (name: string) => {
        const value = raw(name) as { role?: string } | undefined;
        return value?.role ? this.roleCache.get(value.role) : null;
      },
      getChannel: (name: string) => {
        const value = raw(name) as { channel?: string } | undefined;
        return value?.channel ? this.channel(value.channel) : null;
      },
      getFocused: () => "",
    };
  }

  private interaction(
    kind: "command" | "context" | "component",
    person: Person,
    channelId: string,
    extra: {
      commandName?: string;
      usedName?: string;
      options?: unknown;
      customId?: string;
      values?: string[];
      message?: unknown;
      target?: ChatMessage;
      targetMessage?: unknown;
    },
  ) {
    const world = this;
    let reply: ChatMessage | null = null;
    const usedCommand = kind === "component" ? undefined : { by: person, name: extra.usedName ?? "" };
    const privacy = (payload: unknown) =>
      isEphemeral(payload) ? { ephemeral: true, visibleTo: person.id } : { ephemeral: false };
    const interaction = {
      ...extra,
      guild: this.guild,
      guildId: this.guild.id,
      client: this.client,
      user: this.user(person),
      member: this.member(person),
      memberPermissions: { has: () => !!person.staff },
      channel: this.channel(channelId),
      channelId,
      replied: false,
      deferred: false,
      inCachedGuild: () => true,
      isRepliable: () => true,
      isCommand: () => kind !== "component",
      isChatInputCommand: () => kind === "command",
      isAutocomplete: () => false,
      isMessageContextMenuCommand: () => kind === "context",
      isMessageComponent: () => kind === "component",
      isButton: () => kind === "component" && !extra.values,
      isStringSelectMenu: () => kind === "component" && !!extra.values,
      async reply(payload: unknown) {
        interaction.replied = true;
        reply = world.post(channelId, world.tuli, payload, { ...privacy(payload), usedCommand });
      },
      async deferReply(payload: unknown) {
        interaction.deferred = true;
        reply = world.post(
          channelId,
          world.tuli,
          { content: "Tuli is thinking…" },
          { ...privacy(payload), usedCommand },
        );
      },
      async editReply(payload: unknown) {
        if (reply) {
          reply.content = undefined;
          world.apply(reply, payload);
        }
      },
      async followUp(payload: unknown) {
        world.post(channelId, world.tuli, payload, privacy(payload));
      },
      async update(payload: unknown) {
        interaction.replied = true;
        if (extra.target) world.apply(extra.target, payload);
      },
    };
    return interaction;
  }
}
