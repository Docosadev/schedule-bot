import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { config } from "./config.js";
import { getOpenPolls, getPoll } from "./db.js";
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
  .setDescription("日程調整結果からDiscordイベントを作成します")
  .addIntegerOption((option) =>
    option
      .setName("price")
      .setDescription("貸会議室などの利用総額")
      .setRequired(true)
      .setMinValue(0)
  )
  .addIntegerOption((option) =>
    option
      .setName("attendees")
      .setDescription("現地参加人数")
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption((option) =>
    option
      .setName("location")
      .setDescription("会場URLまたは場所")
      .setRequired(true)
      .setMaxLength(500)
  )
  .addStringOption((option) =>
    option
      .setName("message_url")
      .setDescription("対象の結果メッセージURL。省略時は直近100件から探します")
      .setRequired(false)
      .setMaxLength(200)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.CreateEvents);

export const commands = [scheduleCommand.toJSON(), scheduleAdminCommand.toJSON(), createEventCommand.toJSON()];

export async function handleScheduleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "サーバー内のテキストチャンネルで使うのじゃ。", ephemeral: true });
    return;
  }

  const session = createWebSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    creatorId: interaction.user.id
  });
  const url = new URL("/schedule/new", config.webBaseUrl);
  url.searchParams.set("token", session.token);

  await interaction.reply({
    content: `作成画面じゃ。ここから日程調整を始めるのじゃ。\n${url.toString()}\n\nこのリンクは30分だけ有効じゃ。作ったアンケートはこのチャンネルに投稿されるぞ。`,
    ephemeral: true
  });
}

export async function handleScheduleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "list") {
    const polls = (await getOpenPolls()).filter((poll) => poll.guildId === interaction.guildId);
    if (polls.length === 0) {
      await interaction.reply({ content: "受付中のアンケートは今のところないようじゃ。", ephemeral: true });
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
    const poll = await getPoll(pollId);
    if (!poll) {
      await interaction.reply({ content: "指定されたアンケートは見つからんかったぞ。IDをもう一度たしかめるのじゃ。", ephemeral: true });
      return;
    }
    await interaction.reply({ content: await buildPollSummary(poll), embeds: [await buildPollEmbed(poll)], ephemeral: true });
    return;
  }

  if (subcommand === "voters") {
    const pollId = interaction.options.getString("poll_id", true);
    const poll = await getPoll(pollId);
    if (!poll) {
      await interaction.reply({ content: "指定されたアンケートは見つからんかったぞ。IDをもう一度たしかめるのじゃ。", ephemeral: true });
      return;
    }
    await interaction.reply({ content: await buildVoterList(poll), ephemeral: true });
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
