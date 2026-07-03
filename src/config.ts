import "dotenv/config";

export type Config = {
  token: string;
  clientId: string;
  guildId?: string;
  databaseUrl?: string;
  databasePath: string;
  timezone: string;
  reminderHoursBefore: number[];
  scheduleNotifyRoleId?: string;
  docosaMention?: string;
  docosaRoleId?: string;
  googleMapsApiKey?: string;
  webPort: number;
  webHost: string;
  webBaseUrl: string;
  pokemonProductNotifyChannelId?: string;
  pokemonProductCheckTimes: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseReminderHours(value: string | undefined): number[] {
  if (!value) {
    return [24, 3];
  }

  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a);
}

function parseTimes(value: string | undefined, fallback: string[]): string[] {
  const times = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d{2}:\d{2}$/.test(item));

  return times.length ? [...new Set(times)] : fallback;
}

export const config: Config = {
  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("DISCORD_CLIENT_ID"),
  guildId: process.env.DISCORD_GUILD_ID,
  databaseUrl: process.env.DATABASE_URL,
  databasePath: process.env.DATABASE_PATH ?? "./data/schedule-bot.sqlite",
  timezone: process.env.BOT_TIMEZONE ?? "Asia/Tokyo",
  reminderHoursBefore: parseReminderHours(process.env.REMINDER_HOURS_BEFORE),
  scheduleNotifyRoleId: process.env.SCHEDULE_NOTIFY_ROLE_ID,
  docosaMention: process.env.DOCOSA_MENTION,
  docosaRoleId: process.env.DOCOSA_ROLE_ID,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  webPort: Number(process.env.WEB_PORT ?? process.env.PORT ?? "3000"),
  webHost: process.env.WEB_HOST ?? "0.0.0.0",
  webBaseUrl:
    process.env.WEB_BASE_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    `http://localhost:${process.env.WEB_PORT ?? process.env.PORT ?? "3000"}`,
  pokemonProductNotifyChannelId: process.env.POKEMON_PRODUCT_NOTIFY_CHANNEL_ID ?? "1522540129879851158",
  pokemonProductCheckTimes: parseTimes(process.env.POKEMON_PRODUCT_CHECK_TIMES, ["09:00", "15:00", "21:00"])
};
