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

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("このコマンドはメッセージを送れる者だけが使えるのじゃ。");
  }

  const botMember = interaction.guild.members.me;
  if (!botMember) {
    throw new Error("これはいかん、BOTの権限が足りんようじゃ。");
  }

  if (isGuildTextChannel(interaction.channel)) {
    const permissions = interaction.channel.permissionsFor(botMember);
    if (
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks) ||
      !permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
      throw new Error("これはいかん、BOTの権限が足りんようじゃ。");
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
    .setFooter({ text: "みんなもポケモン、ゲットじゃぞ～！" });

  if (staticMapUrl) {
    embed.setImage(staticMapUrl);
  }
  return embed;
}

function formatCreateEventError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "開催情報の作成に失敗してしまったぞ。";
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
): Promise<{
  content: string;
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: ("everyone")[] };
}> {
  if (!interaction.guild || !interaction.guildId || !interaction.channelId) {
    throw new Error("サーバー内で使うコマンドじゃ。");
  }

  return {
    content: "@everyone\n開催情報が確定したぞ。確認しておくんじゃ。",
    embeds: [buildEventInfoEmbed(state, candidate)],
    files: [buildEventThumbnailAttachment()],
    allowedMentions: { parse: ["everyone"] }
  };
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
  const venueUrl = interaction.options.getString("venue_url")?.trim() || null;

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
    const baseState = {
      userId: interaction.user.id,
      title: parsed.title,
      price,
      attendees,
      location,
      venueUrl,
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
      content: "おっと、複数の候補日が見つかったぞ！どの日程で開催情報をまとめるんじゃ？",
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
  await interaction.message.edit({ content: "開催情報をまとめておるぞ。少し待つのじゃ。", components: [] });

  try {
    const message = await createFromCandidate(interaction, state, candidate);
    await interaction.message.edit(message);
  } catch (error) {
    await interaction.message.edit({ content: formatCreateEventError(error), components: [] });
  }
}
