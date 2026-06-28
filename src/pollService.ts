import {
  AttachmentBuilder,
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
  getVotesForPoll,
  replaceVotesForPoll,
  removeVoteForStatus,
  setRemindedMinutes,
  type VoteSnapshot,
  updateOptionMessageId,
  updatePollMessageId,
  updateVoterMessageId
} from "./db.js";
import { formatDeadline, formatOptionLabel, parseDateList, parseLocalDateTime } from "./dateUtils.js";
import { formatRemainingTime, normalizeReminderMinutes, parseReminderMinutesJson } from "./reminders.js";
import { buildOptionMessage, buildPollHeaderMessage, buildResultMessage, buildVotedMembersMessage } from "./render.js";
import { buildResultMatrixImage, type MatrixParticipant } from "./resultImage.js";
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
  if (config.docosaRoleId) {
    return `<@&${config.docosaRoleId}>`;
  }

  if (config.docosaMention) {
    const trimmed = config.docosaMention.trim();
    if (/^\d{17,20}$/.test(trimmed)) {
      return `<@&${trimmed}>`;
    }
    return trimmed;
  }

  if (!guild) {
    console.warn("Docosa mention fallback used because guild is unavailable.");
    return "";
  }

  const roles = await guild.roles.fetch().catch(() => null);
  const role = roles?.find((item) => item.name.trim().toLowerCase() === "docosa");
  if (!role) {
    console.warn("Docosa role was not found. Set DOCOSA_ROLE_ID to enable result mentions.");
    return "";
  }

  return `<@&${role.id}>`;
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

  await createPoll(poll, options);
  const savedPoll = await getPoll(poll.id);
  if (!savedPoll) {
    throw new Error("アンケートの保存に失敗しました。");
  }

  try {
    const headerMessage = await channel.send({
      content: buildPollHeaderMessage(savedPoll),
      allowedMentions: { parse: ["everyone"] }
    });
    sentMessages.push(headerMessage);
    await updatePollMessageId(poll.id, headerMessage.id);

    for (const option of savedPoll.options) {
      const optionMessage = await channel.send({
        content: buildOptionMessage(option, savedPoll),
        flags: MessageFlags.SuppressNotifications
      });
      sentMessages.push(optionMessage);
      await updateOptionMessageId(option.id, optionMessage.id);
      await optionMessage.react(VOTE_EMOJIS.yes);
      await optionMessage.react(VOTE_EMOJIS.no);
      await optionMessage.react(VOTE_EMOJIS.maybe);
    }

    const voterMessage = await channel.send({
      content: buildVotedMembersMessage([]),
      flags: MessageFlags.SuppressNotifications
    });
    sentMessages.push(voterMessage);
    await updateVoterMessageId(poll.id, voterMessage.id);

    return { pollId: poll.id, messageUrl: headerMessage.url };
  } catch (error) {
    await deletePoll(poll.id);
    await Promise.allSettled(sentMessages.map((message) => message.delete()));
    throw error;
  }
}

export async function createSchedulePoll(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "サーバー内のテキストチャンネルで使うのじゃ。", ephemeral: true });
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

  await interaction.reply({ content: "日程調整アンケートを作っておるぞ。少し待つのじゃ。", ephemeral: true });
  if (!isGuildTextChannel(interaction.channel)) {
    throw new Error("アンケートを投稿できるテキストチャンネルで使うのじゃ。");
  }

  const result = await publishSchedulePoll(interaction.channel, input);
  await interaction.editReply(`作成できたぞ: ${result.messageUrl}`);
}

async function refreshVotedMembersMessage(channel: GuildTextBasedChannel, pollId: string): Promise<void> {
  const poll = await getPoll(pollId);
  if (!poll?.voterMessageId) {
    return;
  }

  const names = await resolveVotedMemberNames(channel, pollId);
  const message = await channel.messages.fetch(poll.voterMessageId).catch(() => null);
  await message?.edit(buildVotedMembersMessage(names));
}

async function resolveVotedMemberNames(channel: GuildTextBasedChannel, pollId: string): Promise<string[]> {
  const userIds = await getVotedUserIds(pollId);
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

  const found = await getPollByMessage(reaction.message.id);
  if (!found) {
    return;
  }
  if (found.poll.status !== "open") {
    await reaction.users.remove(user.id).catch(() => undefined);
    return;
  }

  await addVote(found.poll, found.option, user.id, status);
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

  const found = await getPollByMessage(reaction.message.id);
  if (!found || found.poll.status !== "open") {
    return;
  }

  await removeVoteForStatus(found.poll.id, found.option.id, user.id, status);
  if (isGuildTextChannel(reaction.message.channel)) {
    await refreshVotedMembersMessage(reaction.message.channel, found.poll.id);
  }
}

async function removeOtherStatusReactions(message: Message, selected: VoteStatus, userId: string): Promise<void> {
  const fullMessage = await message.fetch().catch(() => message);

  for (const [status, emoji] of Object.entries(VOTE_EMOJIS) as [VoteStatus, string][]) {
    if (status === selected) {
      continue;
    }
    const reaction = fullMessage.reactions.cache.find((item) => item.emoji.name === emoji);
    await reaction?.users.remove(userId).catch((error) => {
      console.warn("failed to remove extra reaction", { messageId: fullMessage.id, userId, emoji }, error);
    });
  }
}

const REACTION_SYNC_ORDER: [VoteStatus, string][] = [
  ["yes", VOTE_EMOJIS.yes],
  ["maybe", VOTE_EMOJIS.maybe],
  ["no", VOTE_EMOJIS.no]
];
const AMBIGUOUS_REACTION_PRIORITY: VoteStatus[] = ["maybe", "no", "yes"];

async function fetchReactionUserIds(reaction: MessageReaction): Promise<string[]> {
  const userIds: string[] = [];
  let after: string | undefined;

  while (true) {
    const users = await reaction.users.fetch({ limit: 100, after }).catch(() => null);
    if (!users || users.size === 0) {
      break;
    }

    for (const user of users.values()) {
      if (!user.bot) {
        userIds.push(user.id);
      }
    }

    after = users.last()?.id;
    if (users.size < 100 || !after) {
      break;
    }
  }

  return userIds;
}

async function syncVotesFromDiscord(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<PollWithOptions> {
  const existingVotes = await getVotesForPoll(poll.id);
  const existingByOptionAndUser = new Map(existingVotes.map((vote) => [`${vote.optionId}:${vote.userId}`, vote.status]));
  const votesByUserAndOption = new Map<string, VoteSnapshot>();

  for (const option of poll.options) {
    if (!option.messageId) {
      continue;
    }

    const message = await channel.messages.fetch(option.messageId).catch(() => null);
    if (!message) {
      continue;
    }

    const statusesByUser = new Map<string, Set<VoteStatus>>();

    for (const [status, emoji] of REACTION_SYNC_ORDER) {
      const reaction = message.reactions.cache.find((item) => item.emoji.name === emoji);
      if (!reaction) {
        continue;
      }

      const userIds = await fetchReactionUserIds(reaction);
      for (const userId of userIds) {
        const statuses = statusesByUser.get(userId) ?? new Set<VoteStatus>();
        statuses.add(status);
        statusesByUser.set(userId, statuses);
      }
    }

    for (const [userId, statuses] of statusesByUser) {
      const key = `${option.id}:${userId}`;
      const existingStatus = existingByOptionAndUser.get(key);
      const selectedStatus =
        existingStatus && statuses.has(existingStatus)
          ? existingStatus
          : statuses.size === 1
            ? [...statuses][0]
            : (AMBIGUOUS_REACTION_PRIORITY.find((status) => statuses.has(status)) ?? "maybe");

      votesByUserAndOption.set(key, { optionId: option.id, userId, status: selectedStatus });

      for (const [status, emoji] of REACTION_SYNC_ORDER) {
        if (status === selectedStatus) {
          continue;
        }
        const reaction = message.reactions.cache.find((item) => item.emoji.name === emoji);
        await reaction?.users.remove(userId).catch((error) => {
          console.warn("failed to clean up ambiguous reaction", { messageId: message.id, userId, emoji }, error);
        });
      }
    }
  }

  await replaceVotesForPoll(poll.id, [...votesByUserAndOption.values()]);
  return (await getPoll(poll.id)) ?? poll;
}

async function buildResultMatrixAttachment(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<AttachmentBuilder | null> {
  try {
    const votes = await getVotesForPoll(poll.id);
    const userIds = [...new Set(votes.map((vote) => vote.userId))];
    const participants = await Promise.all(
      userIds.map(async (userId): Promise<MatrixParticipant> => {
        const member = await channel.guild.members.fetch(userId).catch(() => null);
        if (member) {
          return { userId, displayName: member.displayName };
        }

        const user = await channel.client.users.fetch(userId).catch(() => null);
        return { userId, displayName: user?.displayName ?? user?.username ?? userId };
      })
    );
    participants.sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));

    const image = await buildResultMatrixImage(poll, participants, votes);
    return new AttachmentBuilder(image, { name: `${poll.id}-matrix.png` });
  } catch (error) {
    console.warn("failed to build result matrix image", { pollId: poll.id }, error);
    return null;
  }
}

export async function closeAndReportPoll(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<void> {
  const syncedPoll = await syncVotesFromDiscord(channel, poll);
  await closePoll(syncedPoll.id, "closed");
  const closedPoll = (await getPoll(syncedPoll.id)) ?? syncedPoll;
  const docosaMention = await resolveDocosaMention(channel.guild);
  const matrixAttachment = await buildResultMatrixAttachment(channel, closedPoll);
  await channel.send({
    content: await buildResultMessage(closedPoll, docosaMention),
    files: matrixAttachment ? [matrixAttachment] : [],
    allowedMentions: { parse: ["users", "roles"] }
  });
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
  const duePolls = await getOpenPollsDue(new Date().toISOString());
  for (const poll of duePolls) {
    const channel = await clientChannelsFetch(poll.channelId).catch(() => null);
    if (isGuildTextChannel(channel)) {
      await closeAndReportPoll(channel, poll);
    } else {
      await closePoll(poll.id, "closed");
    }
  }
}

export async function checkReminders(clientChannelsFetch: (channelId: string) => Promise<unknown>): Promise<void> {
  const now = Date.now();
  for (const poll of await getOpenPolls()) {
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
        `日程調整「${poll.title}」の締切まであと${formatRemainingTime(remainingMs)}じゃ。\n締切: ${formatDeadline(poll.deadline)}\nまだの者は投票しておくのじゃ。`
      );
    }
    await setRemindedMinutes(poll.id, newlyRemindedMinutes);
  }
}

export async function closePollByCommand(interaction: ChatInputCommandInteraction, cancelled = false): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pollId = interaction.options.getString("poll_id", true);
  const poll = await getPoll(pollId);
  if (!poll) {
    await interaction.editReply("指定されたアンケートは見つからんかったぞ。IDをもう一度たしかめるのじゃ。");
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.editReply("このアンケートを操作する権限がないようじゃ。");
    return;
  }

  if (cancelled) {
    await closePoll(poll.id, "cancelled");
    await interaction.editReply("アンケートをキャンセルしておいたぞ。");
    return;
  }

  const syncedPoll = isGuildTextChannel(interaction.channel) ? await syncVotesFromDiscord(interaction.channel, poll) : poll;
  await closePoll(syncedPoll.id, "closed");
  const closedPoll = (await getPoll(syncedPoll.id)) ?? syncedPoll;
  const docosaMention = await resolveDocosaMention(interaction.guild);
  if (!isGuildTextChannel(interaction.channel)) {
    await interaction.editReply("アンケートは締め切ったが、結果を投稿するチャンネルが見つからんかったのじゃ。");
    return;
  }

  const matrixAttachment = await buildResultMatrixAttachment(interaction.channel, closedPoll);
  await interaction.channel.send({
    content: await buildResultMessage(closedPoll, docosaMention),
    files: matrixAttachment ? [matrixAttachment] : [],
    allowedMentions: { parse: ["users", "roles"] }
  });
  await interaction.editReply("アンケートを締め切って、結果を投稿しておいたぞ。");
}

export async function extendPollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const deadlineInput = interaction.options.getString("deadline", true);
  const poll = await getPoll(pollId);
  const deadline = parseLocalDateTime(deadlineInput);

  if (!poll || !deadline) {
    await interaction.reply({ content: "アンケートか締切日時を確認できんかったぞ。入力をもう一度見てみるのじゃ。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "このアンケートを操作する権限がないようじゃ。", ephemeral: true });
    return;
  }

  await extendPoll(pollId, deadline.toISOString());
  await interaction.reply(`締切を延ばしておいたぞ: ${formatDeadline(deadline.toISOString())}`);
}

export async function deletePollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const poll = await getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: "指定されたアンケートは見つからんかったぞ。IDをもう一度たしかめるのじゃ。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "このアンケートを操作する権限がないようじゃ。", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "アンケートを片付けておるぞ。少し待つのじゃ。", ephemeral: true });

  let deletedMessages = 0;
  if (isGuildTextChannel(interaction.channel)) {
    deletedMessages = await deletePollMessages(interaction.channel, poll);
  }

  await deletePoll(pollId);
  await interaction.editReply(`アンケートを削除しておいたぞ。関連メッセージも ${deletedMessages} 件片付けたのじゃ。`);
}

export function canManagePoll(interaction: ChatInputCommandInteraction, poll: PollWithOptions): boolean {
  if (interaction.user.id === poll.creatorId) {
    return true;
  }
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has("ManageGuild") || permissions?.has("Administrator"));
}

export async function summarizeCounts(poll: PollWithOptions): Promise<string> {
  const counts = await getVoteCounts(poll.id);
  return poll.options.map((option) => `${option.emoji} ${option.label}: ${counts.get(option.id) ?? 0}票`).join("\n");
}
