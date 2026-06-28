import { format, isValid, parse } from "date-fns";
import { ja } from "date-fns/locale";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { config } from "./config.js";

export function parseLocalDateTime(input: string): Date | null {
  const trimmed = input.trim();
  const patterns = [
    "yyyy-MM-dd HH:mm",
    "yyyy/MM/dd HH:mm",
    "yyyy-MM-dd'T'HH:mm",
    "yyyy/MM/dd'T'HH:mm",
    "yyyy-MM-dd",
    "yyyy/MM/dd",
    "M/d HH:mm",
    "M/d",
    "M月d日 HH:mm",
    "M月d日"
  ];

  for (const pattern of patterns) {
    const parsed = parse(trimmed, pattern, new Date());
    if (isValid(parsed)) {
      return fromZonedTime(parsed, config.timezone);
    }
  }

  const fallback = new Date(trimmed);
  return isValid(fallback) ? fallback : null;
}

export function parseDateList(input: string): Date[] {
  return input
    .split(/[,、\n]/)
    .map((item) => parseLocalDateTime(item))
    .filter((item): item is Date => item !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

export function formatLocalDateTime(date: Date): string {
  const zoned = toZonedTime(date, config.timezone);
  return format(zoned, "yyyy-MM-dd(E) HH:mm", { locale: ja });
}

export function formatOptionLabel(date: Date): string {
  return formatLocalDateTime(date);
}

export function formatDeadline(iso: string): string {
  return formatLocalDateTime(new Date(iso));
}
