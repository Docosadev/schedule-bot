import { format, isValid, parse } from "date-fns";
import { ja } from "date-fns/locale";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { config } from "./config.js";

export function parseLocalDateTime(input: string, timezone = config.timezone): Date | null {
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
      return fromZonedTime(parsed, timezone);
    }
  }

  const fallback = new Date(trimmed);
  return isValid(fallback) ? fallback : null;
}

export function parseDateList(input: string, timezone = config.timezone): Date[] {
  return input
    .split(/[,、\n]/)
    .map((item) => parseLocalDateTime(item, timezone))
    .filter((item): item is Date => item !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

export function formatLocalDateTime(date: Date, timezone = config.timezone): string {
  const zoned = toZonedTime(date, timezone);
  return format(zoned, "yyyy-MM-dd(E) HH:mm", { locale: ja });
}

export function formatOptionLabel(date: Date, timezone = config.timezone): string {
  return formatLocalDateTime(date, timezone);
}

export function formatDeadline(iso: string, timezone = config.timezone): string {
  return formatLocalDateTime(new Date(iso), timezone);
}
