import {
  ChatInputCommandInteraction,
  Guild,
  GuildTextBasedChannel,
  Message,
  MessageFlags,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User
} from "discord.js";
import { config } from "./config.js";
import {
  addVote,
  closePoll,
  createPoll,
  deletePoll,
  extendPoll,
  getOpenPolls,
  getOpenPollsDue,
  getPoll,
  getPollByMessage,
  getVotedUserIds,
  getVoteCounts,
  removeVoteForStatus,
  setRemindedMinutes,
  updateOptionMessageId,
  updatePollMessageId,
  updateVoterMessageId
} from "./db.js";
import { formatDeadline, formatOptionLabel, parseDateList, parseLocalDateTime } from "./dateUtils.js";
import { formatRemainingTime, normalizeReminderMinutes, parseReminderMinutesJson } from "./reminders.js";
import { buildOptionMessage, buildPollHeaderMessage, buildResultMessage, buildVotedMembersMessage } from "./render.js";
import type { Poll, PollOption, PollWithOptions, VoteStatus } from "./types.js";
import { statusFromEmoji, VOTE_EMOJIS } from "./voteEmojis.js";

export type SchedulePollInput = {
  guildId: string;
  channelId: string;
  creatorId: string;
  title: string;
  datesInput: string;
  deadlineInput: string;
  candidateEndTime?: string;
  reminderMinutes?: number[];
  notifyTarget: string | null;
  multipleChoice: boolean;
  anonymous: boolean;
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isGuildTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return typeof channel === "object" && channel !== null && "send" in channel && "messages" in channel;
}

async function resolveDocosaMention(guild: Guild | null): Promise<string> {
  if (config.docosaMention) {
    return config.docosaMention;
  }

  if (!guild) {
    return "@Docosa";
  }

  const roles = await guild.roles.fetch().catch(() => null);
  const role = roles?.find((item) => item.name === "Docosa");
  return role ? `<@&${role.id}>` : "@Docosa";
}

export function buildPollFromInput(params: SchedulePollInput): { poll: Poll; options: PollOption[] } {
  const dates = parseDateList(params.datesInput);
  const deadline = parseLocalDateTime(params.deadlineInput);

  if (!deadline) {
    throw new Error("締切日時を読み取れませんでした。例: 2026-07-01 23:59");
  }
  if (dates.length === 0) {
    throw new Error("候補日を読み取れませんでした。例: 2026-07-03 20:00, 2026-07-04 21:00");
  }
  if (dates.length > 10) {
    throw new Error("候補日は最大10件までです。");
  }
  if (deadline.getTime() <= Date.now()) {
    throw new Error("締切は現在より後の日時にしてください。");
  }

  const pollId = makeId("poll");
  const reminderMinutes = normalizeReminderMinutes(params.reminderMinutes ?? config.reminderHoursBefore.map((hours) => hours * 60));
  const poll: Poll = {
    id: pollId,
    guildId: params.guildId,
    channelId: params.channelId,
    messageId: null,
    voterMessageId: null,
    creatorId: params.creatorId,
    title: params.title,
    deadline: deadline.toISOString(),
    notifyTarget: params.notifyTarget,
    multipleChoice: true,
    anonymous: params.anonymous,
    reminderMinutes: JSON.stringify(reminderMinutes),
    remindedMinutes: "[]",
    status: "open",
    remindedHours: "[]",
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  const options = dates.map((date, index) => ({
    id: makeId("option"),
    pollId,
    messageId: null,
    position: index + 1,
    emoji: String(index + 1),
    startsAt: date.toISOString(),
    label: params.candidateEndTime ? `${formatOptionLabel(date)}-${params.candidateEndTime}` : formatOptionLabel(date)
  }));

  return { poll, options };
}

export async function publishSchedulePoll(
  channel: GuildTextBasedChannel,
  input: SchedulePollInput
): Promise<{ pollId: string; messageUrl: string }> {
  const { poll, options } = buildPollFromInput(input);
  const sentMessages: Message[] = [];

  createPoll(poll, options);
  const savedPoll = getPoll(poll.id);
  if (!savedPoll) {
    throw new Error("アンケートの保存に失敗しました。");
  }

  try {
    const headerMessage = await channel.send({
      content: buildPollHeaderMessage(savedPoll),
      allowedMentions: { parse: ["everyone"] }
    });
    sentMessages.push(headerMessage);
    updatePollMessageId(poll.id, headerMessage.id);

    for (const option of savedPoll.options) {
      const optionMessage = await channel.send({
        content: buildOptionMessage(option, savedPoll),
        flags: MessageFlags.SuppressNotifications
      });
      sentMessages.push(optionMessage);
      updateOptionMessageId(option.id, optionMessage.id);
      await optionMessage.react(VOTE_EMOJIS.yes);
      await optionMessage.react(VOTE_EMOJIS.no);
      await optionMessage.react(VOTE_EMOJIS.maybe);
    }

    const voterMessage = await channel.send({
      content: buildVotedMembersMessage([]),
      flags: MessageFlags.SuppressNotifications
    });
    sentMessages.push(voterMessage);
    updateVoterMessageId(poll.id, voterMessage.id);

    return { pollId: poll.id, messageUrl: headerMessage.url };
  } catch (error) {
    deletePoll(poll.id);
    await Promise.allSettled(sentMessages.map((message) => message.delete()));
    throw error;
  }
}

export async function createSchedulePoll(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "サーバー内のテキストチャンネルで実行してください。", ephemeral: true });
    return;
  }

  const title = interaction.options.getString("title", true);
  const datesInput = interaction.options.getString("dates", true);
  const deadlineInput = interaction.options.getString("deadline", true);
  const notifyRole = interaction.options.getRole("notify_role");
  const notifyUser = interaction.options.getUser("notify_user");
  const multipleChoice = interaction.options.getBoolean("multiple") ?? true;
  const anonymous = interaction.options.getBoolean("anonymous") ?? false;
  const notifyTarget = notifyRole ? `<@&${notifyRole.id}>` : notifyUser ? `<@${notifyUser.id}>` : null;

  const input: SchedulePollInput = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    title,
    datesInput,
    deadlineInput,
    notifyTarget,
    multipleChoice,
    anonymous
  };

  await interaction.reply({ content: "日程調整アンケートを作成しています。", ephemeral: true });
  if (!isGuildTextChannel(interaction.channel)) {
    throw new Error("アンケートを投稿できるテキストチャンネルで実行してください。");
  }

  const result = await publishSchedulePoll(interaction.channel, input);
  await interaction.editReply(`作成しました: ${result.messageUrl}`);
}

async function refreshVotedMembersMessage(channel: GuildTextBasedChannel, pollId: string): Promise<void> {
  const poll = getPoll(pollId);
  if (!poll?.voterMessageId) {
    return;
  }

  const names = await resolveVotedMemberNames(channel, pollId);
  const message = await channel.messages.fetch(poll.voterMessageId).catch(() => null);
  await message?.edit(buildVotedMembersMessage(names));
}

async function resolveVotedMemberNames(channel: GuildTextBasedChannel, pollId: string): Promise<string[]> {
  const userIds = getVotedUserIds(pollId);
  const names: string[] = [];
  for (const userId of userIds) {
    const member = await channel.guild.members.fetch(userId).catch(() => null);
    names.push(member?.displayName ?? `<@${userId}>`);
  }
  return names;
}

export async function handleReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) {
    return;
  }
  if (reaction.partial) {
    await reaction.fetch();
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return;
  }
  const status = statusFromEmoji(emoji);
  if (!status) {
    return;
  }

  const found = getPollByMessage(reaction.message.id, emoji);
  if (!found) {
    return;
  }
  if (found.poll.status !== "open") {
    await reaction.users.remove(user.id).catch(() => undefined);
    return;
  }

  addVote(found.poll, found.option, user.id, status);
  await removeOtherStatusReactions(reaction.message as Message, status, user.id);
  if (isGuildTextChannel(reaction.message.channel)) {
    await refreshVotedMembersMessage(reaction.message.channel, found.poll.id);
  }
}

export async function handleReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) {
    return;
  }
  if (reaction.partial) {
    await reaction.fetch();
  }
  const emoji = reaction.emoji.name;
  if (!emoji) {
    return;
  }
  const status = statusFromEmoji(emoji);
  if (!status) {
    return;
  }

  const found = getPollByMessage(reaction.message.id, emoji);
  if (!found || found.poll.status !== "open") {
    return;
  }

  removeVoteForStatus(found.poll.id, found.option.id, user.id, status);
  if (isGuildTextChannel(reaction.message.channel)) {
    await refreshVotedMembersMessage(reaction.message.channel, found.poll.id);
  }
}

async function removeOtherStatusReactions(message: Message, selected: VoteStatus, userId: string): Promise<void> {
  for (const [status, emoji] of Object.entries(VOTE_EMOJIS) as [VoteStatus, string][]) {
    if (status === selected) {
      continue;
    }
    const reaction = message.reactions.cache.find((item) => item.emoji.name === emoji);
    await reaction?.users.remove(userId).catch(() => undefined);
  }
}

export async function closeAndReportPoll(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<void> {
  closePoll(poll.id, "closed");
  const closedPoll = getPoll(poll.id) ?? poll;
  const docosaMention = await resolveDocosaMention(channel.guild);
  await channel.send({ content: buildResultMessage(closedPoll, docosaMention), allowedMentions: { parse: ["users", "roles"] } });
}

async function deletePollMessages(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<number> {
  const messageIds = [
    poll.messageId,
    ...poll.options.map((option) => option.messageId),
    poll.voterMessageId
  ].filter((messageId): messageId is string => Boolean(messageId));

  let deleted = 0;
  for (const messageId of messageIds) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      continue;
    }
    await message.delete().then(
      () => {
        deleted += 1;
      },
      () => undefined
    );
  }
  return deleted;
}

export async function checkDuePolls(clientChannelsFetch: (channelId: string) => Promise<unknown>): Promise<void> {
  const duePolls = getOpenPollsDue(new Date().toISOString());
  for (const poll of duePolls) {
    const channel = await clientChannelsFetch(poll.channelId).catch(() => null);
    if (isGuildTextChannel(channel)) {
      await closeAndReportPoll(channel, poll);
    } else {
      closePoll(poll.id, "closed");
    }
  }
}

export async function checkReminders(clientChannelsFetch: (channelId: string) => Promise<unknown>): Promise<void> {
  const now = Date.now();
  for (const poll of getOpenPolls()) {
    const deadline = new Date(poll.deadline).getTime();
    const createdAt = new Date(poll.createdAt).getTime();
    const remainingMs = deadline - now;
    if (remainingMs <= 0) {
      continue;
    }

    const reminderMinutes = parseReminderMinutesJson(poll.reminderMinutes);
    const remindedMinutes = parseReminderMinutesJson(poll.remindedMinutes, []);
    const dueReminderMinutes = reminderMinutes.filter((minutes) => {
      const reminderMs = minutes * 60_000;
      const pollExistedBeforeReminder = deadline - createdAt >= reminderMs;
      return pollExistedBeforeReminder && remainingMs <= reminderMs && !remindedMinutes.includes(minutes);
    });
    if (dueReminderMinutes.length === 0) {
      continue;
    }

    const newlyRemindedMinutes = [...new Set([...remindedMinutes, ...dueReminderMinutes])].sort((a, b) => b - a);
    const channel = await clientChannelsFetch(poll.channelId).catch(() => null);
    if (isGuildTextChannel(channel)) {
      await channel.send(
        `日程調整「${poll.title}」の締切まであと${formatRemainingTime(remainingMs)}です。\n締切: ${formatDeadline(poll.deadline)}`
      );
    }
    setRemindedMinutes(poll.id, newlyRemindedMinutes);
  }
}

export async function closePollByCommand(interaction: ChatInputCommandInteraction, cancelled = false): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const poll = getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: "指定されたアンケートが見つかりません。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "このアンケートを操作する権限がありません。", ephemeral: true });
    return;
  }

  if (cancelled) {
    closePoll(poll.id, "cancelled");
    await interaction.reply("アンケートをキャンセルしました。");
    return;
  }

  closePoll(poll.id, "closed");
  const closedPoll = getPoll(poll.id) ?? poll;
  const docosaMention = await resolveDocosaMention(interaction.guild);
  await interaction.reply({
    content: buildResultMessage(closedPoll, docosaMention),
    allowedMentions: { parse: ["users", "roles"] }
  });
}

export async function extendPollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const deadlineInput = interaction.options.getString("deadline", true);
  const poll = getPoll(pollId);
  const deadline = parseLocalDateTime(deadlineInput);

  if (!poll || !deadline) {
    await interaction.reply({ content: "アンケートまたは締切日時を確認できませんでした。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "このアンケートを操作する権限がありません。", ephemeral: true });
    return;
  }

  extendPoll(pollId, deadline.toISOString());
  await interaction.reply(`締切を延長しました: ${formatDeadline(deadline.toISOString())}`);
}

export async function deletePollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const poll = getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: "指定されたアンケートが見つかりません。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "このアンケートを操作する権限がありません。", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "アンケートを削除しています。", ephemeral: true });

  let deletedMessages = 0;
  if (isGuildTextChannel(interaction.channel)) {
    deletedMessages = await deletePollMessages(interaction.channel, poll);
  }

  deletePoll(pollId);
  await interaction.editReply(`アンケートを削除しました。関連メッセージ ${deletedMessages} 件を削除しました。`);
}

export function canManagePoll(interaction: ChatInputCommandInteraction, poll: PollWithOptions): boolean {
  if (interaction.user.id === poll.creatorId) {
    return true;
  }
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has("ManageGuild") || permissions?.has("Administrator"));
}

export function summarizeCounts(poll: PollWithOptions): string {
  const counts = getVoteCounts(poll.id);
  return poll.options.map((option) => `${option.emoji} ${option.label}: ${counts.get(option.id) ?? 0}票`).join("\n");
}
