import type { Message } from "discord.js";
import type { Feature } from "../types.js";
import { commandMention } from "../ui.js";

const greetings = ["Hi", "Hey", "Hello", "Yo", "Howdy"];

// Decides whether a message is aimed at Tuli. `message.client.user` is Tuli itself.
function isTalkingToTuli(message: Message<true>): boolean {
  const tuli = message.client.user;
  // @everyone/@here and plain replies to Tuli's posts don't count, so announcements
  // and people answering Tuli (e.g. a daily question) don't trigger greetings.
  const options = { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true };
  if (message.mentions.has(tuli, options)) return true;

  // Typing @Tuli can autocomplete to Tuli's auto-created role instead of the user.
  const tuliRole = message.guild.members.me?.roles.botRole;
  return tuliRole ? message.mentions.roles.has(tuliRole.id) : false;
}

export const greetFeature: Feature = {
  name: "Greeting",

  async onMessage(message) {
    if (!isTalkingToTuli(message)) return;
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const name = message.member?.displayName ?? message.author.displayName;
    try {
      const help = commandMention(message.client, "tuli");
      await message.reply(`${greeting}, ${name}! 👋 Use ${help} to see what I can do.`);
    } catch (error) {
      // Usually means Tuli lacks Send Messages permission in this channel.
      console.error(`Couldn't reply in #${message.channelId}:`, error);
    }
  },
};
