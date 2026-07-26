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
  ThreadAutoArchiveDuration,
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
  countOpenPollsForGuild,
  getLatestPollCreatedAt,
  getGuildSettings,
  getVotedUserIds,
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
import { resolveNotificationMention } from "./notificationMentions.js";
import { requestPollScheduleRefresh } from "./schedulerHooks.js";
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
  initialNotifyRoleId?: string | null;
  reminderNotifyRoleId?: string | null;
  eventNotifyRoleId?: string | null;
  anonymous: boolean;
  timezone?: string;
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isGuildTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return typeof channel === "object" && channel !== null && "send" in channel && "messages" in channel;
}

type ThreadParentChannel = GuildTextBasedChannel & {
  threads: {
    create(options: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration; reason?: string }): Promise<GuildTextBasedChannel>;
  };
};

function isThreadParentChannel(channel: unknown): channel is ThreadParentChannel {
  return isGuildTextChannel(channel) && "threads" in channel && typeof channel.threads === "object" && channel.threads !== null;
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

function buildThreadName(title: string): string {
  const name = `${title} 日程調整`;
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

function resolveScheduleThreadParent(channel: GuildTextBasedChannel): ThreadParentChannel {
  const parent = channel.isThread() ? channel.parent : channel;
  if (!isThreadParentChannel(parent)) {
    throw new Error("このチャンネルではスレッドを作れないぞー！通常のテキストチャンネルで試してね！");
  }
  return parent;
}

async function createScheduleThread(channel: GuildTextBasedChannel, title: string): Promise<{
  parentChannel: ThreadParentChannel;
  thread: GuildTextBasedChannel;
}> {
  const parentChannel = resolveScheduleThreadParent(channel);
  const name = buildThreadName(title);
  const options = {
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: "Schedule poll thread"
  };

  try {
    return {
      parentChannel,
      thread: await parentChannel.threads.create(options)
    };
  } catch (error) {
    console.warn("failed to create 7-day schedule thread; retrying with 1-day auto archive", { channelId: parentChannel.id }, error);
    return {
      parentChannel,
      thread: await parentChannel.threads.create({
        ...options,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
      })
    };
  }
}

async function fetchPollChannel(interaction: ChatInputCommandInteraction, poll: PollWithOptions): Promise<GuildTextBasedChannel | null> {
  const channel = await interaction.client.channels.fetch(poll.channelId).catch(() => null);
  return isGuildTextChannel(channel) && channel.guild.id === poll.guildId && channel.guild.id === interaction.guildId ? channel : null;
}

export function buildPollFromInput(params: SchedulePollInput): { poll: Poll; options: PollOption[] } {
  const timezone = params.timezone ?? config.timezone;
  const dates = parseDateList(params.datesInput, timezone);
  const deadline = parseLocalDateTime(params.deadlineInput, timezone);

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
    parentChannelId: null,
    messageId: null,
    voterMessageId: null,
    creatorId: params.creatorId,
    title: params.title,
    deadline: deadline.toISOString(),
    timezone,
    notifyTarget: params.notifyTarget,
    initialNotifyRoleId: params.initialNotifyRoleId ?? null,
    reminderNotifyRoleId: params.reminderNotifyRoleId ?? null,
    eventNotifyRoleId: params.eventNotifyRoleId ?? null,
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
    label: params.candidateEndTime ? `${formatOptionLabel(date, timezone)}-${params.candidateEndTime}` : formatOptionLabel(date, timezone)
  }));

  return { poll, options };
}

export async function publishSchedulePoll(
  channel: GuildTextBasedChannel,
  input: SchedulePollInput
): Promise<{ pollId: string; messageUrl: string }> {
  const guildSettings = await getGuildSettings(input.guildId);
  input = { ...input, timezone: guildSettings.timezone };
  const openPollCount = await countOpenPollsForGuild(input.guildId);
  if (openPollCount >= config.maxOpenPollsPerGuild) {
    throw new Error(`このサーバーで受付中の日程調整は最大${config.maxOpenPollsPerGuild}件です。`);
  }
  const latestCreatedAt = await getLatestPollCreatedAt(input.guildId);
  if (latestCreatedAt && Date.now() - new Date(latestCreatedAt).getTime() < config.pollCreationCooldownSeconds * 1000) {
    throw new Error(`連続作成を避けるため${config.pollCreationCooldownSeconds}秒ほど待ってください。`);
  }
  const { poll, options } = buildPollFromInput(input);
  const sentMessages: Message[] = [];
  let thread: GuildTextBasedChannel | null = null;

  try {
    const createdThread = await createScheduleThread(channel, poll.title);
    thread = createdThread.thread;
    const pollInThread: Poll = {
      ...poll,
      channelId: thread.id,
      parentChannelId: createdThread.parentChannel.id
    };
    await createPoll(pollInThread, options);
    const savedPoll = await getPoll(poll.id);
    if (!savedPoll) {
      throw new Error("アンケートの保存に失敗しました。");
    }

    const initialNotification = await resolveNotificationMention(thread, savedPoll.initialNotifyRoleId);
    const personal = guildSettings.messageStyle === "personal";
    const headerMessage = await thread.send({
      content: buildPollHeaderMessage(savedPoll, initialNotification.mention, personal),
      allowedMentions: initialNotification.allowedMentions
    });
    sentMessages.push(headerMessage);
    await updatePollMessageId(poll.id, headerMessage.id);

    for (const option of savedPoll.options) {
      const optionMessage = await thread.send({
        content: buildOptionMessage(option),
        flags: MessageFlags.SuppressNotifications
      });
      sentMessages.push(optionMessage);
      await updateOptionMessageId(option.id, optionMessage.id);
      await optionMessage.react(VOTE_EMOJIS.yes);
      await optionMessage.react(VOTE_EMOJIS.no);
      await optionMessage.react(VOTE_EMOJIS.maybe);
    }

    const voterMessage = await thread.send({
      content: buildVotedMembersMessage([], personal),
      flags: MessageFlags.SuppressNotifications
    });
    sentMessages.push(voterMessage);
    await updateVoterMessageId(poll.id, voterMessage.id);

    requestPollScheduleRefresh();
    return { pollId: poll.id, messageUrl: headerMessage.url };
  } catch (error) {
    await deletePoll(poll.id).catch(() => undefined);
    await Promise.allSettled(sentMessages.map((message) => message.delete()));
    await thread?.delete("Failed to publish schedule poll").catch(() => undefined);
    throw error;
  }
}

async function refreshVotedMembersMessage(channel: GuildTextBasedChannel, pollId: string): Promise<void> {
  const poll = await getPoll(pollId);
  if (!poll?.voterMessageId) {
    return;
  }

  const names = await resolveVotedMemberNames(channel, pollId);
  const personal = (await getGuildSettings(poll.guildId)).messageStyle === "personal";
  const message = await channel.messages.fetch(poll.voterMessageId).catch(() => null);
  await message?.edit(buildVotedMembersMessage(names, personal));
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
  if (reaction.message.guildId !== found.poll.guildId) {
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
  if (reaction.message.guildId !== found.poll.guildId) {
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
  const resultNotification = await resolveNotificationMention(channel, closedPoll.notifyTarget);
  const docosaMention = config.personalGuildId === closedPoll.guildId ? await resolveDocosaMention(channel.guild) : "";
  const matrixAttachment = await buildResultMatrixAttachment(channel, closedPoll);
  await channel.send({
    content: await buildResultMessage(closedPoll, docosaMention, resultNotification.mention),
    files: matrixAttachment ? [matrixAttachment] : [],
    allowedMentions: resultNotification.allowedMentions
  });
}

async function deletePollMessages(channel: GuildTextBasedChannel, poll: PollWithOptions): Promise<number> {
  if (poll.parentChannelId && channel.isThread()) {
    const deleted = await channel.delete("Schedule poll deleted").then(
      () => true,
      () => false
    );
    return deleted ? 1 : 0;
  }

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
    if (isGuildTextChannel(channel) && channel.guild.id === poll.guildId) {
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
    if (isGuildTextChannel(channel) && channel.guild.id === poll.guildId) {
      const notification = await resolveNotificationMention(channel, poll.reminderNotifyRoleId);
      const mention = notification.mention ? `${notification.mention}\n` : "";
      await channel.send({
        content: `${mention}日程調整「${poll.title}」の締切まであと${formatRemainingTime(remainingMs)}です。\n締切: ${formatDeadline(poll.deadline, poll.timezone)}\n投票をお忘れなく。`,
        allowedMentions: notification.allowedMentions
      });
    }
    await setRemindedMinutes(poll.id, newlyRemindedMinutes);
  }
}

export async function closePollByCommand(interaction: ChatInputCommandInteraction, cancelled = false): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pollId = interaction.options.getString("poll_id", true);
  const poll = await getPoll(pollId);
  if (!poll) {
    await interaction.editReply("指定された日程調整が見つかりません。IDを確認してください。");
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.editReply("この日程調整を操作する権限がありません。");
    return;
  }

  if (cancelled) {
    const pollChannel = await fetchPollChannel(interaction, poll);
    await closePoll(poll.id, "cancelled");
    requestPollScheduleRefresh();
    if (pollChannel) {
      if (pollChannel.isThread() && pollChannel.archived) {
        await pollChannel.setArchived(false, "日程調整のキャンセル通知");
      }
      await pollChannel.send({
        content: `日程調整「${poll.title}」はキャンセルされました。`,
        allowedMentions: { parse: [] }
      });
      await interaction.editReply("日程調整をキャンセルし、対象スレッドへ通知しました。");
    } else {
      await interaction.editReply("日程調整をキャンセルしましたが、通知先スレッドが見つかりませんでした。");
    }
    return;
  }

  const pollChannel = await fetchPollChannel(interaction, poll);
  const syncedPoll = pollChannel ? await syncVotesFromDiscord(pollChannel, poll) : poll;
  await closePoll(syncedPoll.id, "closed");
  requestPollScheduleRefresh();
  const closedPoll = (await getPoll(syncedPoll.id)) ?? syncedPoll;
  const docosaMention = config.personalGuildId === closedPoll.guildId ? await resolveDocosaMention(interaction.guild) : "";
  if (!pollChannel) {
    await interaction.editReply("日程調整を締め切りましたが、結果の投稿先チャンネルが見つかりません。");
    return;
  }

  const matrixAttachment = await buildResultMatrixAttachment(pollChannel, closedPoll);
  const resultNotification = await resolveNotificationMention(pollChannel, closedPoll.notifyTarget);
  await pollChannel.send({
    content: await buildResultMessage(closedPoll, docosaMention, resultNotification.mention),
    files: matrixAttachment ? [matrixAttachment] : [],
    allowedMentions: resultNotification.allowedMentions
  });
  await interaction.editReply("日程調整を締め切り、結果を投稿しました。");
}

export async function extendPollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const pollId = interaction.options.getString("poll_id", true);
  const deadlineInput = interaction.options.getString("deadline", true);
  const poll = await getPoll(pollId);
  const deadline = poll ? parseLocalDateTime(deadlineInput, poll.timezone) : null;

  if (!poll || !deadline) {
    await interaction.editReply("日程調整または締切日時を確認できません。入力内容を確認してください。");
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.editReply("この日程調整を操作する権限がありません。");
    return;
  }

  const pollChannel = await fetchPollChannel(interaction, poll);
  await extendPoll(pollId, deadline.toISOString());
  requestPollScheduleRefresh();
  const formattedDeadline = formatDeadline(deadline.toISOString(), poll.timezone);
  if (pollChannel) {
    if (pollChannel.isThread() && pollChannel.archived) {
      await pollChannel.setArchived(false, "日程調整の締切延長通知");
    }
    await pollChannel.send({
      content: `日程調整「${poll.title}」の締切が延長されました。\n新しい締切: ${formattedDeadline}`,
      allowedMentions: { parse: [] }
    });
    await interaction.editReply(`締切を延長し、対象スレッドへ通知しました: ${formattedDeadline}`);
  } else {
    await interaction.editReply(`締切を延長しましたが、通知先スレッドが見つかりませんでした: ${formattedDeadline}`);
  }
}

export async function deletePollByCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const pollId = interaction.options.getString("poll_id", true);
  const poll = await getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: "指定された日程調整が見つかりません。IDを確認してください。", ephemeral: true });
    return;
  }
  if (!canManagePoll(interaction, poll)) {
    await interaction.reply({ content: "この日程調整を操作する権限がありません。", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "日程調整を削除しています。しばらくお待ちください。", ephemeral: true });

  const pollChannel = await fetchPollChannel(interaction, poll);
  const deletedMessages = pollChannel ? await deletePollMessages(pollChannel, poll) : 0;

  await deletePoll(pollId);
  requestPollScheduleRefresh();
  await interaction.editReply(`日程調整を削除しました。関連するメッセージまたはスレッドの削除数: ${deletedMessages}件`);
}

export function canManagePoll(interaction: ChatInputCommandInteraction, poll: PollWithOptions): boolean {
  if (!interaction.guildId || interaction.guildId !== poll.guildId) {
    return false;
  }
  if (interaction.user.id === poll.creatorId) {
    return true;
  }
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has("ManageGuild") || permissions?.has("Administrator"));
}
