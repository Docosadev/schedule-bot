import {
  ChatInputCommandInteraction,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { config } from "./config.js";
import { deleteGuildData, getGuildSettings, getOpenPolls, getPollForGuild, saveGuildSettings } from "./db.js";
import { handleCreateEventCommand } from "./eventService.js";
import {
  closePollByCommand,
  deletePollByCommand,
  extendPollByCommand
} from "./pollService.js";
import { buildPollEmbed, buildPollSummary, buildVoterList } from "./render.js";
import { createWebSession } from "./webSessions.js";

export const scheduleCommand = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Web画面で日程調整アンケートを作成します")
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleAdminCommand = new SlashCommandBuilder()
  .setName("schedule-admin")
  .setDescription("日程調整アンケートを管理します")
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("受付中のアンケートを表示します"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("show")
      .setDescription("アンケートの詳細を表示します")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("voters")
      .setDescription("投票者一覧を表示します")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("close")
      .setDescription("アンケートを締め切って集計します")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("extend")
      .setDescription("アンケートの締切を延長します")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
      .addStringOption((option) => option.setName("deadline").setDescription("新しい締切").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("cancel")
      .setDescription("アンケートをキャンセルします")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("アンケートを削除します")
      .addStringOption((option) => option.setName("poll_id").setDescription("アンケートID").setRequired(true))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const createEventCommand = new SlashCommandBuilder()
  .setName("create-event")
  .setDescription("日程調整結果から開催情報のまとめを投稿します")
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const scheduleSettingsCommand = new SlashCommandBuilder()
  .setName("schedule-settings")
  .setDescription("このサーバーの日程調整設定を管理します")
  .addSubcommand((subcommand) => subcommand.setName("show").setDescription("現在の設定を表示します"))
  .addSubcommand((subcommand) =>
    subcommand.setName("timezone").setDescription("タイムゾーンを変更します")
      .addStringOption((option) => option.setName("value").setDescription("例: Asia/Tokyo").setRequired(true).setMaxLength(64))
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("notifications").setDescription("すべての通知ロールをまとめて変更します")
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("delete-data").setDescription("このサーバーの保存データを削除します")
      .addStringOption((option) => option.setName("confirm").setDescription("確認のため DELETE と入力").setRequired(true))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const personalSettingsCommand = new SlashCommandBuilder()
  .setName("schedule-personal")
  .setDescription("個人サーバー専用の設定を管理します")
  .addSubcommand((subcommand) => subcommand.setName("show").setDescription("個人用設定を表示します"))
  .addSubcommand((subcommand) =>
    subcommand.setName("style").setDescription("メッセージスタイルを変更します")
      .addStringOption((option) => option.setName("value").setDescription("スタイル").setRequired(true)
        .addChoices({ name: "標準", value: "standard" }, { name: "個人", value: "personal" }))
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("pokemon-watcher").setDescription("ポケモン商品監視を設定します")
      .addBooleanOption((option) => option.setName("enabled").setDescription("有効にするか").setRequired(true))
      .addChannelOption((option) => option.setName("channel").setDescription("通知先").addChannelTypes(ChannelType.GuildText))
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("profile").setDescription("このサーバー内のBot名とアイコンを変更します")
      .addStringOption((option) =>
        option.setName("name").setDescription("サーバー内で表示するBot名").setMinLength(1).setMaxLength(32)
      )
      .addAttachmentOption((option) =>
        option.setName("avatar").setDescription("サーバー内で表示するPNG・JPEG・WebP・GIF画像")
      )
      .addBooleanOption((option) =>
        option.setName("reset_avatar").setDescription("サーバー固有アイコンを解除して公開アイコンへ戻す")
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const commands = [
  scheduleCommand.toJSON(),
  scheduleAdminCommand.toJSON(),
  createEventCommand.toJSON(),
  scheduleSettingsCommand.toJSON()
];
export const personalCommands = [personalSettingsCommand.toJSON()];

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

export async function handleScheduleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "list") {
    const polls = (await getOpenPolls()).filter((poll) => poll.guildId === interaction.guildId);
    if (polls.length === 0) {
      await interaction.reply({ content: "受付中の日程調整はありません。", ephemeral: true });
      return;
    }
    await interaction.reply({
      content: polls.map((poll) => `- ${poll.title} / ID: ${poll.id}`).join("\n"),
      ephemeral: true
    });
    return;
  }

  if (subcommand === "show") {
    const pollId = interaction.options.getString("poll_id", true);
    const poll = interaction.guildId ? await getPollForGuild(pollId, interaction.guildId) : null;
    if (!poll) {
      await interaction.reply({ content: "指定された日程調整が見つかりません。IDを確認してください。", ephemeral: true });
      return;
    }
    await interaction.reply({ content: await buildPollSummary(poll), embeds: [await buildPollEmbed(poll)], ephemeral: true });
    return;
  }

  if (subcommand === "voters") {
    const pollId = interaction.options.getString("poll_id", true);
    const poll = interaction.guildId ? await getPollForGuild(pollId, interaction.guildId) : null;
    if (!poll) {
      await interaction.reply({ content: "指定された日程調整が見つかりません。IDを確認してください。", ephemeral: true });
      return;
    }
    await interaction.reply({ content: await buildVoterList(poll), allowedMentions: { parse: [] }, ephemeral: true });
    return;
  }

  if (subcommand === "close") {
    await closePollByCommand(interaction);
    return;
  }

  if (subcommand === "extend") {
    await extendPollByCommand(interaction);
    return;
  }

  if (subcommand === "cancel") {
    await closePollByCommand(interaction, true);
    return;
  }

  if (subcommand === "delete") {
    await deletePollByCommand(interaction);
  }
}

export async function handleCreateEventSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleCreateEventCommand(interaction);
}

export async function handleScheduleSettingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "この設定はサーバー管理権限を持つ人だけが変更できます。", ephemeral: true });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "notifications") {
    await interaction.showModal(buildNotificationSettingsModal());
    return;
  }
  const settings = await getGuildSettings(interaction.guildId);
  if (subcommand === "show") {
    await interaction.reply({
      content: [
        `タイムゾーン: ${settings.timezone}`,
        `初回通知: ${settings.defaultInitialNotifyRoleId ? `<@&${settings.defaultInitialNotifyRoleId}>` : "なし"}`,
        `リマインド通知: ${settings.defaultReminderNotifyRoleId ? `<@&${settings.defaultReminderNotifyRoleId}>` : "なし"}`,
        `結果通知: ${settings.defaultResultNotifyRoleId ? `<@&${settings.defaultResultNotifyRoleId}>` : "なし"}`,
        `開催情報通知: ${settings.defaultEventNotifyRoleId ? `<@&${settings.defaultEventNotifyRoleId}>` : "なし"}`
      ].join("\n"),
      allowedMentions: { parse: [] },
      ephemeral: true
    });
    return;
  }
  if (subcommand === "timezone") {
    const timezone = interaction.options.getString("value", true).trim();
    try {
      new Intl.DateTimeFormat("ja-JP", { timeZone: timezone }).format();
    } catch {
      await interaction.reply({ content: "有効なIANAタイムゾーンを指定してください（例: Asia/Tokyo）。", ephemeral: true });
      return;
    }
    settings.timezone = timezone;
  } else if (subcommand === "delete-data") {
    if (interaction.options.getString("confirm", true) !== "DELETE") {
      await interaction.reply({ content: "削除を確定するには `DELETE` と正確に入力してください。", ephemeral: true });
      return;
    }
    const deleted = await deleteGuildData(interaction.guildId);
    await interaction.reply({
      content: `このサーバーの保存データを削除しました（アンケート ${deleted.polls}件、作成リンク ${deleted.sessions}件、設定 ${deleted.settings}件）。Discord上の既存メッセージは削除されません。`,
      ephemeral: true
    });
    return;
  }
  settings.updatedAt = new Date().toISOString();
  await saveGuildSettings(settings);
  await interaction.reply({ content: "サーバー設定を更新しました。", ephemeral: true });
}

export const NOTIFICATION_SETTINGS_MODAL_ID = "schedule_settings_notifications";
const NOTIFICATION_ROLE_FIELDS = {
  initial: "notification_role_initial",
  reminder: "notification_role_reminder",
  result: "notification_role_result",
  event: "notification_role_event"
} as const;

function buildNotificationRoleLabel(
  label: string,
  description: string,
  customId: string
): LabelBuilder {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("メンションなし")
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1);
  return new LabelBuilder()
    .setLabel(label)
    .setDescription(description)
    .setRoleSelectMenuComponent(select);
}

function buildNotificationSettingsModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(NOTIFICATION_SETTINGS_MODAL_ID)
    .setTitle("通知メンション設定")
    .addLabelComponents(
      buildNotificationRoleLabel(
        "初回投稿",
        "日程調整を作成したときに通知します。",
        NOTIFICATION_ROLE_FIELDS.initial
      ),
      buildNotificationRoleLabel(
        "締切前リマインド",
        "回答締切が近づいたときに通知します。",
        NOTIFICATION_ROLE_FIELDS.reminder
      ),
      buildNotificationRoleLabel(
        "締切・集計結果",
        "日程調整を締め切ったときに通知します。",
        NOTIFICATION_ROLE_FIELDS.result
      ),
      buildNotificationRoleLabel(
        "開催情報",
        "開催情報を投稿したときに通知します。",
        NOTIFICATION_ROLE_FIELDS.event
      )
    );
}

export async function handleNotificationSettingsModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (
    interaction.customId !== NOTIFICATION_SETTINGS_MODAL_ID ||
    !interaction.guildId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "この設定はサーバー管理権限を持つユーザーのみ変更できます。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const selectedRole = (customId: string) => interaction.fields.getSelectedRoles(customId)?.first() ?? null;
  const roles = {
    initial: selectedRole(NOTIFICATION_ROLE_FIELDS.initial),
    reminder: selectedRole(NOTIFICATION_ROLE_FIELDS.reminder),
    result: selectedRole(NOTIFICATION_ROLE_FIELDS.result),
    event: selectedRole(NOTIFICATION_ROLE_FIELDS.event)
  };
  const invalidRole = Object.values(roles).find(
    (role) =>
      role &&
      (role.managed ||
        role.id === interaction.guildId ||
        (!role.mentionable && !interaction.appPermissions?.has(PermissionFlagsBits.MentionEveryone)))
  );
  if (invalidRole) {
    await interaction.reply({
      content: `@${invalidRole.name} は通知に利用できません。Botが通知できる通常ロールを選択してください。`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  settings.defaultInitialNotifyRoleId = roles.initial?.id ?? null;
  settings.defaultReminderNotifyRoleId = roles.reminder?.id ?? null;
  settings.defaultResultNotifyRoleId = roles.result?.id ?? null;
  settings.defaultEventNotifyRoleId = roles.event?.id ?? null;
  settings.updatedAt = new Date().toISOString();
  await saveGuildSettings(settings);
  await interaction.reply({
    content: "通知メンション設定を更新しました。",
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
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "show") {
    await interaction.reply({
      content: [
        `メッセージスタイル: ${settings.messageStyle}`,
        `ポケモン商品監視: ${settings.pokemonWatcherEnabled ? "ON" : "OFF"}`,
        `商品通知チャンネル: ${settings.pokemonNotifyChannelId ? `<#${settings.pokemonNotifyChannelId}>` : "なし"}`
      ].join("\n"),
      allowedMentions: { parse: [] },
      ephemeral: true
    });
    return;
  }

  if (subcommand === "profile") {
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

  if (subcommand === "style") {
    settings.messageStyle = interaction.options.getString("value", true) as "standard" | "personal";
  } else if (subcommand === "pokemon-watcher") {
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
