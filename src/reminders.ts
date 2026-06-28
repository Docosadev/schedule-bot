export const DEFAULT_REMINDER_MINUTES = [24 * 60];

export const REMINDER_CHOICES = [
  { label: "24時間前", minutes: 24 * 60 },
  { label: "12時間前", minutes: 12 * 60 },
  { label: "1時間前", minutes: 60 },
  { label: "30分前", minutes: 30 },
  { label: "15分前", minutes: 15 },
  { label: "10分前", minutes: 10 }
] as const;

const MAX_REMINDER_MINUTES = 7 * 24 * 60;

export function normalizeReminderMinutes(values: unknown, allowedMinutes?: Set<number>): number[] {
  if (!Array.isArray(values)) {
    return [...DEFAULT_REMINDER_MINUTES];
  }

  const normalized = values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= MAX_REMINDER_MINUTES)
    .filter((value) => !allowedMinutes || allowedMinutes.has(value));

  return [...new Set(normalized)].sort((a, b) => b - a);
}

export function parseReminderMinutesJson(value: string | null | undefined, fallback: number[] = DEFAULT_REMINDER_MINUTES): number[] {
  if (!value) {
    return [...fallback];
  }

  try {
    const parsed = normalizeReminderMinutes(JSON.parse(value));
    return parsed.length ? parsed : [...fallback];
  } catch {
    return [...fallback];
  }
}

export function formatReminderMinutes(minutes: number): string {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}時間前` : `${minutes}分前`;
  }
  return `${minutes}分前`;
}

export function formatRemainingTime(remainingMs: number): string {
  const totalMinutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `約${hours}時間` : `約${hours}時間${minutes}分`;
  }
  return `約${totalMinutes}分`;
}
