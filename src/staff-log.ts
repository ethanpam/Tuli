import type { Guild, Message, MessageCreateOptions } from "discord.js";
import { getSetting } from "./settings.js";

/**
 * Posts to the server's staff log channel (set with /admin setup log-channel).
 * Returns the message, or null if there's no log channel or Tuli can't post there.
 */
export async function sendStaffLog(guild: Guild, payload: MessageCreateOptions): Promise<Message | null> {
  const channelId = getSetting(guild.id, "logChannelId");
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) return null;
  try {
    return await channel.send({ allowedMentions: { parse: [] }, ...payload });
  } catch (error) {
    console.error(`Couldn't post to the staff log in ${guild.name}:`, error);
    return null;
  }
}
