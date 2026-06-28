import "dotenv/config";

export type Config = {
  token: string;
  clientId: string;
  guildId?: string;
  databasePath: string;
  timezone: string;
  reminderHoursBefore: number[];
  docosaMention?: string;
  webPort: number;
  webHost: string;
  webBaseUrl: string;
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

export const config: Config = {
  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("DISCORD_CLIENT_ID"),
  guildId: process.env.DISCORD_GUILD_ID,
  databasePath: process.env.DATABASE_PATH ?? "./data/schedule-bot.sqlite",
  timezone: process.env.BOT_TIMEZONE ?? "Asia/Tokyo",
  reminderHoursBefore: parseReminderHours(process.env.REMINDER_HOURS_BEFORE),
  docosaMention: process.env.DOCOSA_MENTION,
  webPort: Number(process.env.WEB_PORT ?? process.env.PORT ?? "3000"),
  webHost: process.env.WEB_HOST ?? "0.0.0.0",
  webBaseUrl: process.env.WEB_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? process.env.PORT ?? "3000"}`
};
