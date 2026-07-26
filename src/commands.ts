import {
  ChatInputCommandInteraction,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import { config } from "./config.js";
import { deleteGuildData, getGuildSettings, saveGuildSettings } from "./db.js";
import { handleCreateEventCommand } from "./eventService.js";
import {
  closePollByCommand,
  deletePollByCommand,
  extendPollByCommand
} from "./pollService.js";
import { createWebSession } from "./webSessions.js";

export const scheduleCommand = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Web画面で日程調整アンケートを作成します")
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

function addPollIdOption(command: SlashCommandBuilder) {
  return command.addStringOption((option) =>
    option.setName("poll_id").setDescription("日程調整ID").setRequired(true)
  );
}

export const scheduleCloseCommand = addPollIdOption(
  new SlashCommandBuilder().setName("schedule-close").setDescription("日程調整を締め切って集計します")
).setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleExtendCommand = addPollIdOption(
  new SlashCommandBuilder().setName("schedule-extend").setDescription("日程調整の締切を延長します")
)
  .addStringOption((option) =>
    option.setName("deadline").setDescription("新しい締切日時").setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleCancelCommand = addPollIdOption(
  new SlashCommandBuilder().setName("schedule-cancel").setDescription("日程調整をキャンセルします")
).setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleDeleteCommand = addPollIdOption(
  new SlashCommandBuilder().setName("schedule-delete").setDescription("日程調整を削除します")
).setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const createEventCommand = new SlashCommandBuilder()
  .setName("create-event")
  .setDescription("日程調整結果から開催情報のまとめを投稿します")
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleTimezoneCommand = new SlashCommandBuilder()
  .setName("schedule-timezone")
  .setDescription("このサーバーのタイムゾーンを選択します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const scheduleDeleteDataCommand = new SlashCommandBuilder()
  .setName("schedule-delete-data")
  .setDescription("このサーバーの保存データを削除します")
  .addStringOption((option) =>
    option.setName("confirm").setDescription("確認のため DELETE と入力").setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const scheduleStyleCommand = new SlashCommandBuilder()
  .setName("schedule-style")
  .setDescription("個人サーバーのメッセージスタイルを変更します")
  .addStringOption((option) =>
    option.setName("value").setDescription("スタイル").setRequired(true)
      .addChoices({ name: "標準", value: "standard" }, { name: "個人", value: "personal" })
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const schedulePokemonCommand = new SlashCommandBuilder()
  .setName("schedule-pokemon")
  .setDescription("個人サーバーのポケモン商品監視を設定します")
  .addBooleanOption((option) => option.setName("enabled").setDescription("有効にするか").setRequired(true))
  .addChannelOption((option) =>
    option.setName("channel").setDescription("通知先").addChannelTypes(ChannelType.GuildText)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const scheduleProfileCommand = new SlashCommandBuilder()
  .setName("schedule-profile")
  .setDescription("個人サーバー内のBot名とアイコンを変更します")
  .addStringOption((option) =>
    option.setName("name").setDescription("サーバー内で表示するBot名").setMinLength(1).setMaxLength(32)
  )
  .addAttachmentOption((option) =>
    option.setName("avatar").setDescription("サーバー内で表示するPNG・JPEG・WebP・GIF画像")
  )
  .addBooleanOption((option) =>
    option.setName("reset_avatar").setDescription("サーバー固有アイコンを解除して公開アイコンへ戻す")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const commands = [
  scheduleCommand.toJSON(),
  createEventCommand.toJSON(),
  scheduleCloseCommand.toJSON(),
  scheduleExtendCommand.toJSON(),
  scheduleCancelCommand.toJSON(),
  scheduleDeleteCommand.toJSON(),
  scheduleTimezoneCommand.toJSON(),
  scheduleDeleteDataCommand.toJSON()
];
export const personalCommands = [
  scheduleStyleCommand.toJSON(),
  schedulePokemonCommand.toJSON(),
  scheduleProfileCommand.toJSON()
];

export const TIMEZONE_SETTINGS_MODAL_ID = "schedule_settings_timezone";
const TIMEZONE_SELECT_ID = "timezone_value";
const TIMEZONE_CHOICES = [
  { label: "日本標準時", description: "東京", value: "Asia/Tokyo" },
  { label: "協定世界時", description: "UTC", value: "UTC" },
  { label: "韓国標準時", description: "ソウル", value: "Asia/Seoul" },
  { label: "中国標準時", description: "上海", value: "Asia/Shanghai" },
  { label: "香港時間", description: "香港", value: "Asia/Hong_Kong" },
  { label: "台湾標準時", description: "台北", value: "Asia/Taipei" },
  { label: "シンガポール時間", description: "シンガポール", value: "Asia/Singapore" },
  { label: "オーストラリア東部時間", description: "シドニー", value: "Australia/Sydney" },
  { label: "英国時間", description: "ロンドン", value: "Europe/London" },
  { label: "中央ヨーロッパ時間", description: "パリ", value: "Europe/Paris" },
  { label: "米国東部時間", description: "ニューヨーク", value: "America/New_York" },
  { label: "米国中部時間", description: "シカゴ", value: "America/Chicago" },
  { label: "米国山岳部時間", description: "デンバー", value: "America/Denver" },
  { label: "米国太平洋時間", description: "ロサンゼルス", value: "America/Los_Angeles" },
  { label: "ハワイ時間", description: "ホノルル", value: "Pacific/Honolulu" },
  { label: "ニュージーランド時間", description: "オークランド", value: "Pacific/Auckland" }
] as const;

export async function handleScheduleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "このコマンドはサーバー内のテキストチャンネルで実行してください。", ephemeral: true });
    return;
  }

  const session = await createWebSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    creatorId: interaction.user.id
  });
  const url = new URL("/schedule/new", config.webBaseUrl);
  url.searchParams.set("token", session.token);

  await interaction.reply({
    content: `以下の作成画面から日程調整を作成してください。\n${url.toString()}\n\nリンクの有効時間は30分です。作成した日程調整は新しいスレッドに投稿されます。`,
    ephemeral: true
  });
}

export async function handleScheduleManagementCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "schedule-close") {
    await closePollByCommand(interaction);
    return;
  }
  if (interaction.commandName === "schedule-extend") {
    await extendPollByCommand(interaction);
    return;
  }
  if (interaction.commandName === "schedule-cancel") {
    await closePollByCommand(interaction, true);
    return;
  }
  if (interaction.commandName === "schedule-delete") {
    await deletePollByCommand(interaction);
  }
}

export async function handleCreateEventSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleCreateEventCommand(interaction);
}

export async function handleScheduleTimezoneCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "この設定はサーバー管理権限を持つ人だけが変更できます。", ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(TIMEZONE_SETTINGS_MODAL_ID)
    .setTitle("タイムゾーン設定")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("タイムゾーン")
        .setDescription("日程と締切の表示に使用する地域を選択してください。")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(TIMEZONE_SELECT_ID)
            .setPlaceholder("タイムゾーンを選択")
            .setRequired(true)
            .addOptions(...TIMEZONE_CHOICES)
        )
    );
  await interaction.showModal(modal);
}

export async function handleScheduleDeleteDataCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "この設定はサーバー管理権限を持つ人だけが変更できます。", ephemeral: true });
    return;
  }
  if (interaction.options.getString("confirm", true) !== "DELETE") {
    await interaction.reply({ content: "削除を確定するには `DELETE` と正確に入力してください。", ephemeral: true });
    return;
  }
  const deleted = await deleteGuildData(interaction.guildId);
  await interaction.reply({
    content: `このサーバーの保存データを削除しました（アンケート ${deleted.polls}件、作成リンク ${deleted.sessions}件、設定 ${deleted.settings}件）。Discord上の既存メッセージは削除されません。`,
    ephemeral: true
  });
}

export async function handleTimezoneSettingsModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (
    interaction.customId !== TIMEZONE_SETTINGS_MODAL_ID ||
    !interaction.guildId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "この設定はサーバー管理権限を持つユーザーのみ変更できます。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const timezone = interaction.fields.getStringSelectValues(TIMEZONE_SELECT_ID)[0];
  const choice = TIMEZONE_CHOICES.find((item) => item.value === timezone);
  if (!choice) {
    await interaction.reply({
      content: "選択されたタイムゾーンを確認できません。もう一度実行してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  settings.timezone = choice.value;
  settings.updatedAt = new Date().toISOString();
  await saveGuildSettings(settings);
  await interaction.reply({
    content: `タイムゾーンを「${choice.label}（${choice.value}）」に設定しました。`,
    flags: MessageFlags.Ephemeral
  });
}

export async function handlePersonalSettingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || interaction.guildId !== config.personalGuildId) {
    await interaction.reply({ content: "このコマンドは個人サーバーでのみ実行できます。", ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "この設定はサーバー管理権限を持つユーザーのみ変更できます。", ephemeral: true });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  if (interaction.commandName === "schedule-profile") {
    const nickname = interaction.options.getString("name")?.trim() || null;
    const avatar = interaction.options.getAttachment("avatar");
    const resetAvatar = interaction.options.getBoolean("reset_avatar") ?? false;
    if (!nickname && !avatar && !resetAvatar) {
      await interaction.reply({ content: "変更するBot名またはアイコンを指定してください。", ephemeral: true });
      return;
    }
    if (avatar && resetAvatar) {
      await interaction.reply({ content: "アイコン画像とアイコン解除は同時に指定できません。", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const body: { nick?: string; avatar?: string | null } = {};
    if (nickname) body.nick = nickname;
    if (resetAvatar) {
      body.avatar = null;
    } else if (avatar) {
      body.avatar = await downloadProfileImage(avatar.url, avatar.contentType, avatar.size);
    }
    await interaction.client.rest.patch(Routes.guildMember(interaction.guildId, "@me"), { body });
    await interaction.editReply("このサーバー内のBotプロフィールを更新しました。");
    return;
  }

  if (interaction.commandName === "schedule-style") {
    settings.messageStyle = interaction.options.getString("value", true) as "standard" | "personal";
  } else if (interaction.commandName === "schedule-pokemon") {
    const enabled = interaction.options.getBoolean("enabled", true);
    const channel = interaction.options.getChannel("channel");
    if (enabled && !channel) {
      await interaction.reply({ content: "有効にする場合は通知先チャンネルを指定してください。", ephemeral: true });
      return;
    }
    settings.pokemonWatcherEnabled = enabled;
    settings.pokemonNotifyChannelId = enabled ? channel!.id : null;
  }

  settings.updatedAt = new Date().toISOString();
  await saveGuildSettings(settings);
  await interaction.reply({ content: "個人サーバー設定を更新しました。", ephemeral: true });
}

async function downloadProfileImage(url: string, contentType: string | null, size: number): Promise<string> {
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (!contentType || !allowedTypes.has(contentType)) {
    throw new Error("アイコンにはPNG、JPEG、WebP、GIF画像を指定してください。");
  }
  if (size > 10 * 1024 * 1024) {
    throw new Error("アイコン画像は10MB以下にしてください。");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("アイコン画像を取得できませんでした。");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}
