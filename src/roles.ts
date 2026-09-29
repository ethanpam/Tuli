import { PermissionFlagsBits, type GuildMember, type Role } from "discord.js";

// Permissions a reward role must never carry, so nobody can earn or buy their way into staff powers.
const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageWebhooks,
];

/** Why this role can't be used as a reward (level or shop), or null if it can. */
export function rewardRoleProblem(role: Role): string | null {
  const me = role.guild.members.me;
  if (role.id === role.guild.id) return "@everyone can't be a reward.";
  if (role.managed) return `${role} belongs to a bot or integration, so it can't be handed out.`;
  if (role.permissions.any(STAFF_PERMISSIONS)) return `${role} has staff permissions, so it can't be a reward.`;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles))
    return "Tuli needs the **Manage Roles** permission to hand out roles.";
  if (role.comparePositionTo(me.roles.highest) >= 0) {
    return `Tuli can only hand out roles below its own. In Server Settings → Roles, drag **${me.roles.highest.name}** above ${role}.`;
  }
  return null;
}

/** Gives a role, returning an error message instead of throwing if Discord refuses. */
export async function giveRole(member: GuildMember, roleId: string, reason: string): Promise<string | null> {
  if (member.roles.cache.has(roleId)) return null;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return "That role no longer exists.";
  const problem = rewardRoleProblem(role);
  if (problem) return problem;
  try {
    await member.roles.add(role, reason);
    return null;
  } catch (error) {
    console.error(`Couldn't give ${role.name} to ${member.user.tag}:`, error);
    return `Discord wouldn't let Tuli give ${role}.`;
  }
}
