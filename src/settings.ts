import { db } from "./db.js";

/** Every per-server setting Tuli has, and its type. Unset settings fall back to defaults. */
export interface Settings {
  /** Where Tuli posts staff alerts: scam reports, shop orders, question suggestions. */
  logChannelId: string;
  /** IANA name like "America/Chicago". Used for daily resets and question schedules. */
  timezone: string;
}

export const DEFAULT_TIMEZONE = "America/Chicago";

const selectValue = db.prepare("SELECT value FROM guild_settings WHERE guild_id = $guildId AND key = $key");
const upsertValue = db.prepare(`
  INSERT INTO guild_settings (guild_id, key, value) VALUES ($guildId, $key, $value)
  ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value`);
const deleteValue = db.prepare("DELETE FROM guild_settings WHERE guild_id = $guildId AND key = $key");
const selectByKey = db.prepare("SELECT guild_id, value FROM guild_settings WHERE key = $key");

export function getSetting<K extends keyof Settings>(guildId: string, key: K): Settings[K] | undefined {
  const row = selectValue.get({ guildId, key }) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Settings[K]) : undefined;
}

/** Saves a setting, or clears it when value is undefined. */
export function setSetting<K extends keyof Settings>(guildId: string, key: K, value: Settings[K] | undefined): void {
  if (value === undefined) deleteValue.run({ guildId, key });
  else upsertValue.run({ guildId, key, value: JSON.stringify(value) });
}

/** Every server that has this setting, e.g. all servers with a question schedule. */
export function guildsWithSetting<K extends keyof Settings>(key: K): { guildId: string; value: Settings[K] }[] {
  const rows = selectByKey.all({ key }) as { guild_id: string; value: string }[];
  return rows.map((row) => ({ guildId: row.guild_id, value: JSON.parse(row.value) as Settings[K] }));
}

export function getTimezone(guildId: string): string {
  return getSetting(guildId, "timezone") ?? DEFAULT_TIMEZONE;
}
