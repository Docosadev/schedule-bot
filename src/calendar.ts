import type { CalendarEventRecord } from "./db.js";

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function normalizeUrl(value: string | null): string | null {
  if (!value || !/^https?:\/\//i.test(value)) {
    return null;
  }
  return value;
}

export function buildIcs(event: CalendarEventRecord): string {
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  const createdAt = new Date(event.createdAt);
  const venueUrl = normalizeUrl(event.venueUrl);
  const description = venueUrl ? `会場リンク: ${venueUrl}` : "Discord Schedule Botで作成した予定です。";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Discord Schedule Bot//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.token}@discord-schedule-bot`,
    `DTSTAMP:${formatIcsDate(createdAt)}`,
    `DTSTART:${formatIcsDate(startsAt)}`,
    `DTEND:${formatIcsDate(endsAt)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `LOCATION:${escapeIcsText(event.location)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    ...(venueUrl ? [`URL:${venueUrl}`] : []),
    "END:VEVENT",
    "END:VCALENDAR"
  ];

  return `${lines.join("\r\n")}\r\n`;
}
