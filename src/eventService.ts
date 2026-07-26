import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildTextBasedChannel,
  LabelBuilder,
  Message,
  MessageFlags,
  type MessageMentionOptions,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { getGuildSettings, getPollForGuild } from "./db.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { parseLocalDateTime } from "./dateUtils.js";
import { resolveNotificationMention } from "./notificationMentions.js";

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
  price: number | null;
  attendees: number | null;
  address: string | null;
  eventChannelId: string | null;
  customMessage: string | null;
  fee: number | null;
  pollId: string | null;
  createdAt: number;
};

const PENDING_EVENT_TTL_MS = 15 * 60_000;
const pendingEventCreations = new Map<string, PendingEventCreation>();
export const CREATE_EVENT_MODAL_ID = "create_event_input";

type CreateEventInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;
type EventPostInteraction = ModalSubmitInteraction | StringSelectMenuInteraction;

function isGuildTextChannel(channel: unknown): channel is GuildTextBasedChannel {
  return typeof channel === "object" && channel !== null && "send" in channel && "messages" in channel;
}

function formatYen(amount: number): string {
  return new Intl.NumberFormat("ja-JP").format(amount);
}

function buildEventInfoDescription(
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate
): string {
  const sections = [`**🗓️ 開催日時**\n${candidate.label}`];
  if (state.fee !== null) {
    sections.push(`**💰 今回の参加費**\n${formatYen(state.fee)}円`);
  }
  if (state.price !== null) {
    sections.push(`**🧾 利用総額**\n${formatYen(state.price)}円`);
  }
  if (state.attendees !== null) {
    sections.push(`**👥 参加人数**\n${state.attendees}人`);
  }
  if (state.address) {
    const googleMapsUrl = buildGoogleMapsSearchUrl(state.address);
    sections.push(`**📍 開催場所（住所）**\n${state.address}\n[Google Mapsで開く](${googleMapsUrl})`);
  }
  if (state.eventChannelId) {
    sections.push(`**💬 開催場所（チャンネル）**\n<#${state.eventChannelId}>`);
  }
  if (state.customMessage) {
    sections.push(`**📝 メッセージ**\n${state.customMessage}`);
  }
  return sections.join("\n\n");
}

function buildGoogleMapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function buildStaticMapUrl(address: string | null): string | null {
  if (!address || !config.googleMapsApiKey) {
    return null;
  }

  const params = new URLSearchParams({
    center: address,
    zoom: "16",
    size: "640x400",
    scale: "2",
    language: "ja",
    region: "JP",
    markers: `color:red|${address}`,
    key: config.googleMapsApiKey
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
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

async function resolveSourceMessage(interaction: CreateEventInteraction): Promise<Message<true>> {
  if (!isGuildTextChannel(interaction.channel)) {
    throw new Error("サーバー内のテキストチャンネルで実行してください。");
  }

  const message = await findLatestResultMessage(interaction.channel);
  if (!message) {
    throw new Error("対象の日程調整結果が見つかりません。結果メッセージと同じチャンネルで実行してください。");
  }
  return message;
}

function assertCreateEventPermissions(interaction: CreateEventInteraction): void {
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
  const staticMapUrl = buildStaticMapUrl(state.address);
  const embed = new EmbedBuilder()
    .setColor(0xe33555)
    .setTitle(state.title)
    .setDescription(buildEventInfoDescription(state, candidate))
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
  interaction: EventPostInteraction,
  state: Omit<PendingEventCreation, "token" | "candidates" | "createdAt">,
  candidate: EventCandidate
): Promise<{
  content: string;
  embeds: EmbedBuilder[];
  allowedMentions: MessageMentionOptions;
}> {
  if (!interaction.guild || !interaction.guildId || !interaction.channelId) {
    throw new Error("このコマンドはサーバー内で実行してください。");
  }

  const settings = await getGuildSettings(interaction.guildId);
  const poll = state.pollId ? await getPollForGuild(state.pollId, interaction.guildId) : null;
  const target = poll?.eventNotifyRoleId ?? settings.defaultEventNotifyRoleId;
  const notification = await resolveNotificationMention(resolveEventInfoOutputChannel(interaction), target);
  const mention = notification.mention ? `${notification.mention}\n` : "";
  return {
    content: `${mention}開催情報が決定しました。内容をご確認ください。`,
    embeds: [buildEventInfoEmbed(state, candidate)],
    allowedMentions: notification.allowedMentions
  };
}

function resolveEventInfoOutputChannel(interaction: EventPostInteraction): GuildTextBasedChannel {
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
  interaction: EventPostInteraction,
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
  interaction: EventPostInteraction,
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
  await interaction.showModal(buildCreateEventModal());
}

function buildCreateEventModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CREATE_EVENT_MODAL_ID)
    .setTitle("開催情報の入力")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("利用総額（円）")
        .setDescription("貸会議室などの利用総額を入力してください。")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("event_price")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("例: 10000")
            .setRequired(false)
            .setMaxLength(12)
        ),
      new LabelBuilder()
        .setLabel("参加人数")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("event_attendees")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("例: 5")
            .setRequired(false)
            .setMaxLength(6)
        ),
      new LabelBuilder()
        .setLabel("開催場所（住所）")
        .setDescription("入力した場合だけGoogle Mapsと地図を表示します。")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("event_address")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500)
        ),
      new LabelBuilder()
        .setLabel("開催場所（チャンネル）")
        .setDescription("Discord内の開催チャンネルを選択してください。")
        .setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder()
            .setCustomId("event_channel")
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(1)
        ),
      new LabelBuilder()
        .setLabel("自由入力メッセージ")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("event_custom_message")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000)
        )
    );
}

function parseOptionalIntegerInput(value: string, label: string, minimum: number): number | null {
  const normalized = value.trim().replace(/[,\s]/g, "");
  if (!normalized) {
    return null;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label}は半角数字で入力してください。`);
  }
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new Error(`${label}は${minimum}以上の整数で入力してください。`);
  }
  return result;
}

export async function handleCreateEventModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== CREATE_EVENT_MODAL_ID) {
    return;
  }
  assertCreateEventPermissions(interaction);

  const price = parseOptionalIntegerInput(interaction.fields.getTextInputValue("event_price"), "利用総額", 0);
  const attendees = parseOptionalIntegerInput(interaction.fields.getTextInputValue("event_attendees"), "参加人数", 1);
  const address = interaction.fields.getTextInputValue("event_address").trim() || null;
  const eventChannelId = interaction.fields.getSelectedChannels(
    "event_channel",
    false,
    [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice]
  )?.first()?.id ?? null;
  const customMessage = interaction.fields.getTextInputValue("event_custom_message").trim() || null;
  if (price === null && attendees === null && !address && !eventChannelId && !customMessage) {
    await interaction.reply({
      content: "開催情報を1項目以上入力してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const sourceMessage = await resolveSourceMessage(interaction);
    const parsed = parseResultMessage(sourceMessage.content);
    if (!parsed) {
      await interaction.editReply("日程調整結果を解析できません。対象メッセージを確認してください。");
      return;
    }

    const fee = price !== null && attendees !== null ? Math.ceil(price / attendees) : null;
    const baseState = {
      userId: interaction.user.id,
      title: parsed.title,
      price,
      attendees,
      address,
      eventChannelId,
      customMessage,
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
    await interaction.message.edit({ content: `開催情報を投稿しました: ${postedMessage.url}`, components: [] });
  } catch (error) {
    await interaction.message.edit({ content: formatCreateEventError(error), components: [] });
  }
}
