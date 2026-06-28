import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildTextBasedChannel,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction
} from "discord.js";
import { randomUUID } from "node:crypto";
import { getCreatedEventBySourceMessage, recordCreatedEvent } from "./db.js";
import { parseLocalDateTime } from "./dateUtils.js";

type EventCandidate = {
  label: string;
  startAt: Date;
  endAt: Date;
};

type ParsedResultMessage = {
  title: string;
  candidates: EventCandidate[];
};

type PendingEventCreation = {
  token: string;
  userId: string;
  channelId: string;
  sourceMessageId: string;
  sourceMessageUrl: string;
  title: string;
  candidates: EventCandidate[];
  price: number;
  attendees: number;
  location: string;
  fee: number;
  createdAt: number;
};

const PENDING_EVENT_TTL_MS = 15 * 60_000;
const pendingEventCreations = new Map<string, PendingEventCreation>();

function isGuildTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return typeof channel === "object" && channel !== null && "send" in channel && "messages" in channel;
}

function formatYen(amount: number): string {
  return new Intl.NumberFormat("ja-JP").format(amount);
}

function makeEventUrl(guildId: string, scheduledEventId: string): string {
  return `https://discord.com/events/${guildId}/${scheduledEventId}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function parseMessageUrl(input: string): { guildId: string; channelId: string; messageId: string } | null {
  const match = input.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) {
    return null;
  }
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

export function parseResultMessage(content: string): ParsedResultMessage | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  let title: string | null = null;
  const candidates: EventCandidate[] = [];

  for (const line of lines) {
    const normalized = line.replace(/\*\*/g, "");
    const currentTitle =
      normalized.match(/^#\s+(.+?)\s+日程調整結果$/)?.[1] ??
      normalized.match(/^#\s+日程調整結果:\s*(.+)$/)?.[1] ??
      null;
    if (currentTitle) {
      title = currentTitle.trim();
      continue;
    }

    const candidateMatch = normalized.match(/^>\s*##\s+(\d{4}-\d{2}-\d{2})\([^)]+\)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!candidateMatch) {
      continue;
    }

    const [, date, startTime, endTime] = candidateMatch;
    const startAt = parseLocalDateTime(`${date} ${startTime}`);
    const endAt = parseLocalDateTime(`${date} ${endTime}`);
    if (!startAt || !endAt) {
      continue;
    }

    const normalizedEndAt = endAt.getTime() <= startAt.getTime() ? new Date(endAt.getTime() + 24 * 60 * 60_000) : endAt;
    candidates.push({
      label: `${date} ${startTime}-${endTime}`,
      startAt,
      endAt: normalizedEndAt
    });
  }

  if (!title || candidates.length === 0) {
    return null;
  }

  return { title, candidates };
}

async function fetchSourceMessageByUrl(interaction: ChatInputCommandInteraction, messageUrl: string): Promise<Message<true>> {
  const parsed = parseMessageUrl(messageUrl);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    throw new Error("メッセージURLを読み取れんかったぞ。同じサーバーの結果メッセージURLを指定しておくれ。");
  }

  const channel = await interaction.client.channels.fetch(parsed.channelId).catch(() => null);
  if (!isGuildTextChannel(channel)) {
    throw new Error("指定されたメッセージのチャンネルを確認できんかったぞ。");
  }

  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message?.inGuild()) {
    throw new Error("指定された結果メッセージが見つからんかったぞ。");
  }
  if (!message.author.bot) {
    throw new Error("指定されたメッセージは調整BOTの結果メッセージではなさそうじゃ。");
  }

  return message;
}

async function findLatestResultMessage(channel: GuildTextBasedChannel): Promise<Message<true> | null> {
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const message of messages.values()) {
    if (!message.author.bot) {
      continue;
    }
    if (parseResultMessage(message.content)) {
      return message;
    }
  }
  return null;
}

async function resolveSourceMessage(interaction: ChatInputCommandInteraction): Promise<Message<true>> {
  const messageUrl = interaction.options.getString("message_url");
  if (messageUrl) {
    return fetchSourceMessageByUrl(interaction, messageUrl);
  }

  if (!isGuildTextChannel(interaction.channel)) {
    throw new Error("サーバー内のテキストチャンネルで使うのじゃ。");
  }

  const message = await findLatestResultMessage(interaction.channel);
  if (!message) {
    throw new Error("該当する調整BOTのメッセージが見つからんかったぞ。もう一度確認しておくれ。");
  }
  return message;
}

function assertCreateEventPermissions(interaction: ChatInputCommandInteraction): void {
  if (!interaction.guild || !interaction.guildId) {
    throw new Error("サーバー内で使うコマンドじゃ。");
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.CreateEvents)) {
    throw new Error("このコマンドはイベントを作成できる者だけが使えるのじゃ。");
  }

  const botMember = interaction.guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.CreateEvents)) {
    throw new Error("これはいかん、BOTの権限が足りんようじゃ。");
  }

  if (isGuildTextChannel(interaction.channel)) {
    const permissions = interaction.channel.permissionsFor(botMember);
    if (!permissions?.has(PermissionFlagsBits.ReadMessageHistory) || !permissions.has(PermissionFlagsBits.SendMessages)) {
      throw new Error("これはいかん、BOTの権限が足りんようじゃ。");
    }
  }
}

function buildDescription(params: {
  fee: number;
  price: number;
  attendees: number;
  location: string;
  sourceMessageUrl: string;
}): string {
  return [
    "開催場所と日時です。会場の詳細な場所はリンクを参照してください。",
    `今回の参加費：${formatYen(params.fee)}円`,
    `利用総額：${formatYen(params.price)}円 / 現地参加：${params.attendees}人`,
    `会場リンク：${params.location}`,
    `(元メッセージ: ${params.sourceMessageUrl})`
  ].join("\n");
}

function resolveEventLocation(location: string): string {
  return location.length <= 100 ? location : "会場リンクは概要を参照";
}

async function createScheduledEvent(params: {
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction;
  sourceMessageId: string;
  sourceChannelId: string;
  sourceMessageUrl: string;
  title: string;
  candidate: EventCandidate;
  price: number;
  attendees: number;
  location: string;
  fee: number;
}): Promise<{ eventUrl: string; alreadyCreated: boolean }> {
  if (!params.interaction.guild || !params.interaction.guildId || !params.interaction.channelId) {
    throw new Error("サーバー内で使うコマンドじゃ。");
  }

  const existing = await getCreatedEventBySourceMessage(params.sourceMessageId);
  if (existing) {
    return { eventUrl: makeEventUrl(existing.guildId, existing.scheduledEventId), alreadyCreated: true };
  }

  const scheduledEvent = await params.interaction.guild.scheduledEvents.create({
    name: params.title,
    scheduledStartTime: params.candidate.startAt,
    scheduledEndTime: params.candidate.endAt,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location: resolveEventLocation(params.location) },
    description: truncate(
      buildDescription({
        fee: params.fee,
        price: params.price,
        attendees: params.attendees,
        location: params.location,
        sourceMessageUrl: params.sourceMessageUrl
      }),
      1000
    ),
    reason: "Schedule result converted to Discord event"
  });

  await recordCreatedEvent({
    sourceMessageId: params.sourceMessageId,
    guildId: params.interaction.guildId,
    channelId: params.sourceChannelId,
    scheduledEventId: scheduledEvent.id,
    createdBy: params.interaction.user.id,
    createdAt: new Date().toISOString()
  });

  return { eventUrl: scheduledEvent.url, alreadyCreated: false };
}

function buildSuccessMessage(title: string, fee: number, eventUrl: string): string {
  return [
    `イベント【${title}】の作成が完了したぞ！`,
    `今回の現地参加費は **${formatYen(fee)}円** じゃ。`,
    "現地参加の者は、忘れずに準備しておくれ。",
    "",
    eventUrl
  ].join("\n");
}

function buildAlreadyCreatedMessage(eventUrl: string): string {
  return [
    "この結果からのイベントは、すでに作成済みじゃ。",
    "必要ならこちらから確認しておくれ。",
    "",
    eventUrl
  ].join("\n");
}

function formatCreateEventError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "イベント作成に失敗してしまったぞ。";
  }
  if (/Missing Permissions|Missing Access|権限/.test(error.message)) {
    return "これはいかん、BOTの権限が足りんようじゃ。";
  }
  return error.message;
}

async function createFromCandidate(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate
): Promise<string> {
  const result = await createScheduledEvent({
    interaction,
    sourceMessageId: state.sourceMessageId,
    sourceChannelId: state.channelId,
    sourceMessageUrl: state.sourceMessageUrl,
    title: state.title,
    candidate,
    price: state.price,
    attendees: state.attendees,
    location: state.location,
    fee: state.fee
  });
  return result.alreadyCreated ? buildAlreadyCreatedMessage(result.eventUrl) : buildSuccessMessage(state.title, state.fee, result.eventUrl);
}

function buildCandidateSelect(state: PendingEventCreation): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`create_event:${state.token}`)
    .setPlaceholder("採用する日程を選ぶのじゃ")
    .addOptions(
      state.candidates.map((candidate, index) => ({
        label: candidate.label,
        value: String(index)
      }))
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export async function handleCreateEventCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  assertCreateEventPermissions(interaction);

  const price = interaction.options.getInteger("price", true);
  const attendees = interaction.options.getInteger("attendees", true);
  const location = interaction.options.getString("location", true).trim();

  if (attendees <= 0) {
    await interaction.reply({ content: "これこれ、参加人数に0は指定できんぞ。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (price < 0) {
    await interaction.reply({ content: "利用総額は0円以上で指定しておくれ。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!location) {
    await interaction.reply({ content: "会場リンクや場所を入力しておくれ。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  try {
    const sourceMessage = await resolveSourceMessage(interaction);
    const parsed = parseResultMessage(sourceMessage.content);
    if (!parsed) {
      await interaction.editReply("メッセージの解析に失敗してしまったぞ。フォーマットを確認しておくれ。");
      return;
    }

    const fee = Math.ceil(price / attendees);
    const existing = await getCreatedEventBySourceMessage(sourceMessage.id);
    if (existing) {
      await interaction.editReply(buildAlreadyCreatedMessage(makeEventUrl(existing.guildId, existing.scheduledEventId)));
      return;
    }

    const baseState = {
      userId: interaction.user.id,
      channelId: sourceMessage.channelId,
      sourceMessageId: sourceMessage.id,
      sourceMessageUrl: sourceMessage.url,
      title: parsed.title,
      price,
      attendees,
      location,
      fee
    };

    if (parsed.candidates.length === 1) {
      const message = await createFromCandidate(interaction, baseState, parsed.candidates[0]);
      await interaction.editReply(message);
      return;
    }

    const token = randomUUID();
    const state: PendingEventCreation = {
      ...baseState,
      token,
      candidates: parsed.candidates,
      createdAt: Date.now()
    };
    pendingEventCreations.set(token, state);

    await interaction.editReply({
      content: "おっと、複数の候補日が見つかったぞ！どの日程を採用するんじゃ？",
      components: [buildCandidateSelect(state)]
    });
  } catch (error) {
    await interaction.editReply(formatCreateEventError(error));
  }
}

export async function handleCreateEventSelection(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.customId.startsWith("create_event:")) {
    return;
  }

  const token = interaction.customId.slice("create_event:".length);
  const state = pendingEventCreations.get(token);
  if (!state || Date.now() - state.createdAt > PENDING_EVENT_TTL_MS) {
    pendingEventCreations.delete(token);
    await interaction.reply({ content: "選択の期限が切れてしまったようじゃ。もう一度 `/create-event` を実行しておくれ。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== state.userId) {
    await interaction.reply({ content: "これこれ、この操作は実行者のみ可能じゃぞ。", flags: MessageFlags.Ephemeral });
    return;
  }

  const candidate = state.candidates[Number(interaction.values[0])];
  if (!candidate) {
    await interaction.reply({ content: "選ばれた日程を確認できんかったぞ。", flags: MessageFlags.Ephemeral });
    return;
  }

  pendingEventCreations.delete(token);
  await interaction.deferUpdate();
  await interaction.message.edit({ content: "イベントを作成しておるぞ。少し待つのじゃ。", components: [] });

  try {
    const message = await createFromCandidate(interaction, state, candidate);
    await interaction.message.edit({ content: message, components: [] });
  } catch (error) {
    await interaction.message.edit({ content: formatCreateEventError(error), components: [] });
  }
}
