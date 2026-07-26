import {
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type MessageMentionOptions
} from "discord.js";

export const EVERYONE_NOTIFICATION_TARGET = "@everyone";
export const HERE_NOTIFICATION_TARGET = "@here";

export function isBroadcastNotificationTarget(target: string | null | undefined): boolean {
  return target === EVERYONE_NOTIFICATION_TARGET || target === HERE_NOTIFICATION_TARGET;
}

export function formatNotificationTarget(target: string | null): string | null {
  if (!target || isBroadcastNotificationTarget(target)) {
    return target;
  }
  return `<@&${target}>`;
}

export async function resolveNotificationMention(
  channel: GuildTextBasedChannel,
  target: string | null | undefined
): Promise<{ mention: string; allowedMentions: MessageMentionOptions }> {
  if (!target) {
    return { mention: "", allowedMentions: { parse: [] } };
  }

  const botMember = channel.guild.members.me ?? await channel.guild.members.fetchMe().catch(() => null);
  const canMentionEveryone = Boolean(
    botMember && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MentionEveryone)
  );
  if (isBroadcastNotificationTarget(target)) {
    return canMentionEveryone
      ? { mention: target, allowedMentions: { parse: ["everyone"] } }
      : { mention: "", allowedMentions: { parse: [] } };
  }

  const roleId = target.match(/^<@&(\d{17,20})>$/)?.[1] ?? (/^\d{17,20}$/.test(target) ? target : null);
  if (!roleId || roleId === channel.guild.id) {
    return { mention: "", allowedMentions: { parse: [] } };
  }
  const role = await channel.guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.managed || (!role.mentionable && !canMentionEveryone)) {
    return { mention: "", allowedMentions: { parse: [] } };
  }
  return {
    mention: `<@&${role.id}>`,
    allowedMentions: { parse: [], roles: [role.id] }
  };
}
