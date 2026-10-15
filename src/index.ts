import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials
} from "discord.js";
import {
  handleCreateEventSlashCommand,
  handlePersonalSettingsCommand,
  handleScheduleCommand,
  handleScheduleDeleteDataCommand,
  handleScheduleExtendModal,
  handleScheduleManagementCommand,
  handleScheduleTimezoneCommand,
  handleTimezoneSettingsModal,
  SCHEDULE_EXTEND_MODAL_ID,
  TIMEZONE_SETTINGS_MODAL_ID
} from "./commands.js";
import { config } from "./config.js";
import { getDiscordConnectionStatus, trackDiscordConnection } from "./discordConnection.js";
import { getGuildSettings, hasGuildSettings, migrate, saveGuildSettings } from "./db.js";
import { CREATE_EVENT_MODAL_ID, handleCreateEventModal, handleCreateEventSelection } from "./eventService.js";
import { handleReactionAdd, handleReactionRemove } from "./pollService.js";
import { startPokemonProductScheduler } from "./pokemonProductWatcher.js";
import { startPollScheduler } from "./pollScheduler.js";
import { startWebServer } from "./webServer.js";

await migrate();
if (config.personalGuildId && !(await hasGuildSettings(config.personalGuildId))) {
  const personalSettings = await getGuildSettings(config.personalGuildId);
  personalSettings.messageStyle = "personal";
  personalSettings.pokemonWatcherEnabled = Boolean(config.pokemonProductNotifyChannelId);
  personalSettings.pokemonNotifyChannelId = config.pokemonProductNotifyChannelId ?? null;
  personalSettings.updatedAt = new Date().toISOString();
  await saveGuildSettings(personalSettings);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

startWebServer(client);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  void startPollScheduler(client).catch((error) => {
    console.error("poll scheduler startup failed", error);
  });
  startPokemonProductScheduler((channelId) => client.channels.fetch(channelId));
});

client.on(Events.Error, (error) => {
  console.error("Discord client error", error);
});

client.on(Events.ShardError, (error, shardId) => {
  console.error("Discord shard error", { shardId }, error);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  console.warn("Discord shard disconnected", { shardId, code: event.code, reason: event.reason });
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn("Discord shard reconnecting", { shardId });
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  console.log("Discord shard resumed", { shardId, replayedEvents });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId === CREATE_EVENT_MODAL_ID) {
        await handleCreateEventModal(interaction);
        return;
      }
      if (interaction.customId === TIMEZONE_SETTINGS_MODAL_ID) {
        await handleTimezoneSettingsModal(interaction);
        return;
      }
      if (interaction.customId === SCHEDULE_EXTEND_MODAL_ID) {
        await handleScheduleExtendModal(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("create_event:")) {
      await handleCreateEventSelection(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "schedule") {
      await handleScheduleCommand(interaction);
      return;
    }
    if (interaction.commandName === "create-event") {
      await handleCreateEventSlashCommand(interaction);
      return;
    }
    if (["schedule-close", "schedule-extend", "schedule-cancel", "schedule-delete"].includes(interaction.commandName)) {
      await handleScheduleManagementCommand(interaction);
      return;
    }
    if (interaction.commandName === "schedule-timezone") {
      await handleScheduleTimezoneCommand(interaction);
      return;
    }
    if (interaction.commandName === "schedule-delete-data") {
      await handleScheduleDeleteDataCommand(interaction);
      return;
    }
    if (["schedule-style", "schedule-pokemon", "schedule-profile"].includes(interaction.commandName)) {
      await handlePersonalSettingsCommand(interaction);
    }
  } catch (error) {
    console.error("interaction handling failed", {
      type: interaction.type,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : undefined,
      customId: interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId : undefined
    }, error);
    const message = error instanceof Error ? error.message : "予期しないエラーが発生しました。時間をおいて再度実行してください。";
    try {
      if (!interaction.isRepliable()) {
        console.error("interaction is not repliable", error);
        return;
      }
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error("interaction error response failed", replyError);
    }
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await handleReactionAdd(reaction, user);
  } catch (error) {
    console.error("messageReactionAdd failed", error);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    await handleReactionRemove(reaction, user);
  } catch (error) {
    console.error("messageReactionRemove failed", error);
  }
});

trackDiscordConnection(client);
const connectionWatch = setInterval(() => {
  if (!client.isReady()) {
    console.warn("Discord connection pending", getDiscordConnectionStatus(client));
  }
}, 60_000);
connectionWatch.unref();
await client.login(config.token);
