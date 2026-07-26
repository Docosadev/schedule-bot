import { REST, Routes } from "discord.js";
import { commands, personalCommands } from "./commands.js";
import { config } from "./config.js";

const rest = new REST({ version: "10" }).setToken(config.token);

await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
console.log(`Registered ${commands.length} global command(s).`);

if (config.personalGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.personalGuildId), { body: personalCommands });
  console.log(`Registered ${personalCommands.length} personal command(s) in guild ${config.personalGuildId}.`);
}

if (config.guildId && config.guildId !== config.personalGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log(`Registered ${commands.length} test command(s) in guild ${config.guildId}.`);
}
