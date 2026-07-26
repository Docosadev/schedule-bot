import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildTextBasedChannel,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction
} from "discord.js";
import { getGuildSettings, getPollForGuild } from "./db.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "./config.js";
import { parseLocalDateTime } from "./dateUtils.js";

type EventCandidate = {
  label: string;
  startAt: Date;
  endAt: Date;
};

type ParsedResultMessage = {
  title: string;
  candidates: EventCandidate[];
  pollId: string | null;
};

type PendingEventCreation = {
  token: string;
  userId: string;
  title: string;
  candidates: EventCandidate[];
  price: number;
  attendees: number;
  location: string;
  venueUrl: string | null;
  fee: number;
  pollId: string | null;
  createdAt: number;
};

const PENDING_EVENT_TTL_MS = 15 * 60_000;
const EVENT_THUMBNAIL_FILE_NAME = "icon_calender.png";
const EVENT_THUMBNAIL_PATH = resolve(process.cwd(), "assets", EVENT_THUMBNAIL_FILE_NAME);
const pendingEventCreations = new Map<string, PendingEventCreation>();

function isGuildTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return typeof channel === "object" && channel !== null && "send" in channel && "messages" in channel;
}

function formatYen(amount: number): string {
  return new Intl.NumberFormat("ja-JP").format(amount);
}

function isProbablyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function buildLocationValue(location: string, venueUrl: string | null): string {
  if (!venueUrl || venueUrl === location) {
    return location;
  }
  return `${location}\n${venueUrl}`;
}

function buildEventInfoDescription(
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate,
  venueUrl: string | null
): string {
  return [
    `**🗓️ 開催日時**\n${candidate.label}`,
    `**💰 今回の参加費**\n${formatYen(state.fee)}円`,
    `**🧾 利用総額 / 現地参加**\n${formatYen(state.price)}円 / ${state.attendees}人`,
    `**📍 開催場所**\n${buildLocationValue(state.location, venueUrl)}`
  ].join("\n\n");
}

function buildGoogleMapsSearchUrl(location: string): string | null {
  if (isProbablyUrl(location)) {
    return null;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

function resolveVenueUrl(location: string, venueUrl: string | null): string | null {
  if (venueUrl) {
    return venueUrl;
  }
  if (isProbablyUrl(location)) {
    return location;
  }
  return buildGoogleMapsSearchUrl(location);
}

function buildStaticMapUrl(location: string): string | null {
  if (!config.googleMapsApiKey || isProbablyUrl(location)) {
    return null;
  }

  const params = new URLSearchParams({
    center: location,
    zoom: "16",
    size: "640x400",
    scale: "2",
    language: "ja",
    region: "JP",
    markers: `color:red|${location}`,
    key: config.googleMapsApiKey
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

function buildEventThumbnailAttachment(): AttachmentBuilder {
  return new AttachmentBuilder(EVENT_THUMBNAIL_PATH, { name: EVENT_THUMBNAIL_FILE_NAME });
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
  let pollId: string | null = null;
  const candidates: EventCandidate[] = [];

  for (const line of lines) {
    const normalized = line.replace(/\*\*/g, "");
    const currentTitle =
      normalized.match(/^#{1,2}\s+(.+?)\s+日程調整結果$/)?.[1] ??
      normalized.match(/^#{1,2}\s+日程調整結果:\s*(.+)$/)?.[1] ??
      null;
    if (currentTitle) {
      title = currentTitle.trim();
      continue;
    }
    const currentPollId = normalized.match(/^ID:\s*(poll_[A-Za-z0-9_]+)$/)?.[1];
    if (currentPollId) {
      pollId = currentPollId;
      continue;
    }

    const candidateMatch = normalized.match(/^>\s*(?:##\s*)?(\d{4}-\d{2}-\d{2})\(([^)]+)\)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!candidateMatch) {
      continue;
    }

    const [, date, weekday, startTime, endTime] = candidateMatch;
    const startAt = parseLocalDateTime(`${date} ${startTime}`);
    const endAt = parseLocalDateTime(`${date} ${endTime}`);
    if (!startAt || !endAt) {
      continue;
    }

    const normalizedEndAt = endAt.getTime() <= startAt.getTime() ? new Date(endAt.getTime() + 24 * 60 * 60_000) : endAt;
    candidates.push({
      label: `${date}(${weekday}) ${startTime}-${endTime}`,
      startAt,
      endAt: normalizedEndAt
    });
  }

  if (!title || candidates.length === 0) {
    return null;
  }

  return { title, candidates, pollId };
}

async function fetchSourceMessageByUrl(interaction: ChatInputCommandInteraction, messageUrl: string): Promise<Message<true>> {
  const parsed = parseMessageUrl(messageUrl);
  if (!parsed || parsed.guildId !== interaction.guildId) {
    throw new Error("メッセージURLを読み取れません。同じサーバーの結果メッセージURLを指定してください。");
  }

  const channel = await interaction.client.channels.fetch(parsed.channelId).catch(() => null);
  if (!isGuildTextChannel(channel)) {
    throw new Error("指定されたメッセージのチャンネルを確認できません。");
  }

  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message?.inGuild()) {
    throw new Error("指定された結果メッセージが見つかりません。");
  }
  if (!message.author.bot) {
    throw new Error("指定されたメッセージは、このBotが投稿した日程調整結果ではありません。");
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
    throw new Error("サーバー内のテキストチャンネルで実行してください。");
  }

  const message = await findLatestResultMessage(interaction.channel);
  if (!message) {
    throw new Error("対象の日程調整結果が見つかりません。メッセージURLを指定して再度実行してください。");
  }
  return message;
}

function assertCreateEventPermissions(interaction: ChatInputCommandInteraction): void {
  if (!interaction.guild || !interaction.guildId) {
    throw new Error("このコマンドはサーバー内で実行してください。");
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("このコマンドを実行するにはメッセージ送信権限が必要です。");
  }

  const botMember = interaction.guild.members.me;
  if (!botMember) {
    throw new Error("Botに必要な権限がありません。");
  }

  if (isGuildTextChannel(interaction.channel)) {
    const permissions = interaction.channel.permissionsFor(botMember);
    if (
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      throw new Error("Botに必要な権限がありません。");
    }
  }
}

function buildEventInfoEmbed(state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">, candidate: EventCandidate): EmbedBuilder {
  const venueUrl = resolveVenueUrl(state.location, state.venueUrl);
  const staticMapUrl = buildStaticMapUrl(state.location);
  const embed = new EmbedBuilder()
    .setColor(0xe33555)
    .setTitle(state.title)
    .setDescription(buildEventInfoDescription(state, candidate, venueUrl))
    .setThumbnail(`attachment://${EVENT_THUMBNAIL_FILE_NAME}`)
    .setFooter({ text: "開催情報をご確認ください。" });

  if (staticMapUrl) {
    embed.setImage(staticMapUrl);
  }
  return embed;
}

function formatCreateEventError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "開催情報の作成に失敗しました。";
  }
  if (/Missing Permissions|Missing Access|権限/.test(error.message)) {
    return "Botに必要な権限がありません。";
  }
  return error.message;
}

async function createFromCandidate(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate
): Promise<{
  content: string;
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: []; roles?: string[] };
}> {
  if (!interaction.guild || !interaction.guildId || !interaction.channelId) {
    throw new Error("このコマンドはサーバー内で実行してください。");
  }

  const settings = await getGuildSettings(interaction.guildId);
  const poll = state.pollId ? await getPollForGuild(state.pollId, interaction.guildId) : null;
  const roleId = poll?.eventNotifyRoleId ?? settings.defaultEventNotifyRoleId;
  const role = roleId
    ? await interaction.guild.roles.fetch(roleId).catch(() => null)
    : null;
  const mention = role && role.mentionable && !role.managed ? `<@&${role.id}>\n` : "";
  return {
    content: `${mention}開催情報が決定しました。内容をご確認ください。`,
    embeds: [buildEventInfoEmbed(state, candidate)],
    files: [buildEventThumbnailAttachment()],
    allowedMentions: role ? { parse: [], roles: [role.id] } : { parse: [] }
  };
}

function resolveEventInfoOutputChannel(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction): GuildTextBasedChannel {
  if (!isGuildTextChannel(interaction.channel)) {
    throw new Error("サーバー内のテキストチャンネルで実行してください。");
  }

  if (interaction.channel.isThread()) {
    const parent = interaction.channel.parent;
    if (isGuildTextChannel(parent)) {
      return parent;
    }
  }

  return interaction.channel;
}

function assertCanPostEventInfo(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  channel: GuildTextBasedChannel
): void {
  const botMember = interaction.guild?.members.me;
  if (!botMember) {
    throw new Error("Botに必要な権限がありません。");
  }

  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has(PermissionFlagsBits.SendMessages) ||
    !permissions.has(PermissionFlagsBits.EmbedLinks)
  ) {
    throw new Error("Botに必要な権限がありません。");
  }
}

async function postEventInfo(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate
): Promise<Message<true>> {
  const outputChannel = resolveEventInfoOutputChannel(interaction);
  assertCanPostEventInfo(interaction, outputChannel);
  const message = await createFromCandidate(interaction, state, candidate);
  return outputChannel.send(message);
}

function buildCandidateSelect(state: PendingEventCreation): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`create_event:${state.token}`)
    .setPlaceholder("開催する日程を選択してください")
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
  const venueUrl = interaction.options.getString("venue_url")?.trim() || null;

  if (attendees <= 0) {
    await interaction.reply({ content: "参加人数は1人以上で指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (price < 0) {
    await interaction.reply({ content: "利用総額は0円以上で指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!location) {
    await interaction.reply({ content: "会場名、住所、または会場URLを入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  try {
    const sourceMessage = await resolveSourceMessage(interaction);
    const parsed = parseResultMessage(sourceMessage.content);
    if (!parsed) {
      await interaction.editReply("日程調整結果を解析できません。対象メッセージを確認してください。");
      return;
    }

    const fee = Math.ceil(price / attendees);
    const baseState = {
      userId: interaction.user.id,
      title: parsed.title,
      price,
      attendees,
      location,
      venueUrl,
      fee,
      pollId: parsed.pollId
    };

    if (parsed.candidates.length === 1) {
      const postedMessage = await postEventInfo(interaction, baseState, parsed.candidates[0]);
      await interaction.editReply(`開催情報を投稿しました: ${postedMessage.url}`);
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
      content: "候補日が複数あります。開催する日程を選択してください。",
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
    await interaction.reply({ content: "選択の有効期限が切れました。もう一度 `/create-event` を実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== state.userId) {
    await interaction.reply({ content: "この操作はコマンドを実行したユーザーのみ実行できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const candidate = state.candidates[Number(interaction.values[0])];
  if (!candidate) {
    await interaction.reply({ content: "選択された日程を確認できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  pendingEventCreations.delete(token);
  await interaction.deferUpdate();
  await interaction.message.edit({ content: "開催情報を作成しています。しばらくお待ちください。", components: [] });

  try {
    const postedMessage = await postEventInfo(interaction, state, candidate);
    await interaction.message.edit({ content: `開催情報を本流チャンネルへ投稿しておいたぞ: ${postedMessage.url}`, components: [] });
  } catch (error) {
    await interaction.message.edit({ content: formatCreateEventError(error), components: [] });
  }
}
