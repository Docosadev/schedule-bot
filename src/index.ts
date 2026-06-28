import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials
} from "discord.js";
import { handleScheduleAdminCommand, handleScheduleCommand } from "./commands.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { checkDuePolls, checkReminders, handleReactionAdd, handleReactionRemove } from "./pollService.js";
import { startWebServer } from "./webServer.js";

await migrate();

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

  setInterval(() => {
    void checkDuePolls((channelId) => client.channels.fetch(channelId));
    void checkReminders((channelId) => client.channels.fetch(channelId));
  }, 60_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "schedule") {
      await handleScheduleCommand(interaction);
      return;
    }
    if (interaction.commandName === "schedule-admin") {
      await handleScheduleAdminCommand(interaction);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
    try {
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

await client.login(config.token);
