import { REST, Routes } from "discord.js";
import { commands, personalCommands } from "./commands.js";
import { config } from "./config.js";

const rest = new REST({ version: "10" }).setToken(config.token);

if (config.guildId) {
  const guildCommands = config.guildId === config.personalGuildId ? [...commands, ...personalCommands] : commands;
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: guildCommands });
  console.log(`Registered ${guildCommands.length} command(s) in test guild ${config.guildId}.`);
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  console.log(`Registered ${commands.length} global command(s).`);
}

if (config.personalGuildId && config.personalGuildId !== config.guildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.personalGuildId), { body: personalCommands });
  console.log(`Registered ${personalCommands.length} personal command(s) in guild ${config.personalGuildId}.`);
}
