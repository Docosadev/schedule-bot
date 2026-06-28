import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config } from "./config.js";

const rest = new REST({ version: "10" }).setToken(config.token);

if (config.guildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log(`Registered ${commands.length} guild command(s).`);
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  console.log(`Registered ${commands.length} global command(s).`);
}

