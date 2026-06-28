import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { Poll, PollOption, PollStatus, PollWithOptions, Vote, VoteStatus } from "./types.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      voter_message_id TEXT,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      deadline TEXT NOT NULL,
      notify_target TEXT,
      multiple_choice INTEGER NOT NULL DEFAULT 1,
      anonymous INTEGER NOT NULL DEFAULT 0,
      reminder_minutes TEXT NOT NULL DEFAULT '[1440]',
      reminded_minutes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      reminded_hours TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      message_id TEXT,
      position INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      label TEXT NOT NULL,
      UNIQUE(poll_id, emoji),
      UNIQUE(poll_id, position)
    );

    CREATE TABLE IF NOT EXISTS votes (
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'yes',
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, option_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_polls_status_deadline ON polls(status, deadline);
    CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
  `);

  ensureColumn("votes", "status", "TEXT NOT NULL DEFAULT 'yes'");
  ensureColumn("poll_options", "message_id", "TEXT");
  ensureColumn("polls", "voter_message_id", "TEXT");
  ensureColumn("polls", "reminder_minutes", "TEXT NOT NULL DEFAULT '[1440]'");
  ensureColumn("polls", "reminded_minutes", "TEXT NOT NULL DEFAULT '[]'");
}

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapPoll(row: Record<string, unknown>): Poll {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: row.message_id ? String(row.message_id) : null,
    voterMessageId: row.voter_message_id ? String(row.voter_message_id) : null,
    creatorId: String(row.creator_id),
    title: String(row.title),
    deadline: String(row.deadline),
    notifyTarget: row.notify_target ? String(row.notify_target) : null,
    multipleChoice: Boolean(row.multiple_choice),
    anonymous: Boolean(row.anonymous),
    reminderMinutes: row.reminder_minutes ? String(row.reminder_minutes) : "[1440]",
    remindedMinutes: row.reminded_minutes ? String(row.reminded_minutes) : "[]",
    status: String(row.status) as PollStatus,
    remindedHours: String(row.reminded_hours),
    createdAt: String(row.created_at),
    closedAt: row.closed_at ? String(row.closed_at) : null
  };
}

function mapOption(row: Record<string, unknown>): PollOption {
  return {
    id: String(row.id),
    pollId: String(row.poll_id),
    messageId: row.message_id ? String(row.message_id) : null,
    position: Number(row.position),
    emoji: String(row.emoji),
    startsAt: String(row.starts_at),
    label: String(row.label)
  };
}

export function createPoll(poll: Poll, options: PollOption[]): void {
  const insertPoll = db.prepare(`
    INSERT INTO polls (
      id, guild_id, channel_id, message_id, voter_message_id, creator_id, title, deadline,
      notify_target, multiple_choice, anonymous, reminder_minutes, reminded_minutes, status, reminded_hours,
      created_at, closed_at
    )
    VALUES (
      @id, @guildId, @channelId, @messageId, @voterMessageId, @creatorId, @title, @deadline,
      @notifyTarget, @multipleChoice, @anonymous, @reminderMinutes, @remindedMinutes, @status, @remindedHours,
      @createdAt, @closedAt
    )
  `);
  const insertOption = db.prepare(`
    INSERT INTO poll_options (id, poll_id, message_id, position, emoji, starts_at, label)
    VALUES (@id, @pollId, @messageId, @position, @emoji, @startsAt, @label)
  `);

  db.transaction(() => {
    insertPoll.run({
      ...poll,
      multipleChoice: poll.multipleChoice ? 1 : 0,
      anonymous: poll.anonymous ? 1 : 0
    });
    for (const option of options) {
      insertOption.run(option);
    }
  })();
}

export function updatePollMessageId(pollId: string, messageId: string): void {
  db.prepare("UPDATE polls SET message_id = ? WHERE id = ?").run(messageId, pollId);
}

export function updateVoterMessageId(pollId: string, messageId: string): void {
  db.prepare("UPDATE polls SET voter_message_id = ? WHERE id = ?").run(messageId, pollId);
}

export function updateOptionMessageId(optionId: string, messageId: string): void {
  db.prepare("UPDATE poll_options SET message_id = ? WHERE id = ?").run(messageId, optionId);
}

export function getPoll(pollId: string): PollWithOptions | null {
  const pollRow = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId) as Record<string, unknown> | undefined;
  if (!pollRow) {
    return null;
  }

  const optionRows = db
    .prepare("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC")
    .all(pollId) as Record<string, unknown>[];

  return {
    ...mapPoll(pollRow),
    options: optionRows.map(mapOption)
  };
}

export function getPollByMessage(messageId: string, emoji: string): { poll: PollWithOptions; option: PollOption } | null {
  const optionRow = db.prepare("SELECT * FROM poll_options WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined;
  if (!optionRow) {
    return null;
  }

  const poll = getPoll(String(optionRow.poll_id));
  if (!poll) {
    return null;
  }

  const option = poll.options.find((item) => item.id === optionRow.id);
  if (!option) {
    return null;
  }

  return { poll, option };
}

export function addVote(poll: Poll, option: PollOption, userId: string, status: VoteStatus = "yes"): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO votes (poll_id, option_id, user_id, status, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(poll_id, option_id, user_id)
      DO UPDATE SET status = excluded.status, created_at = excluded.created_at
    `).run(poll.id, option.id, userId, status, new Date().toISOString());
  })();
}

export function removeVote(pollId: string, optionId: string, userId: string): void {
  db.prepare("DELETE FROM votes WHERE poll_id = ? AND option_id = ? AND user_id = ?").run(pollId, optionId, userId);
}

export function removeVoteForStatus(pollId: string, optionId: string, userId: string, status: VoteStatus): void {
  db.prepare("DELETE FROM votes WHERE poll_id = ? AND option_id = ? AND user_id = ? AND status = ?").run(
    pollId,
    optionId,
    userId,
    status
  );
}

export function getVoteCounts(pollId: string): Map<string, number> {
  const rows = db
    .prepare("SELECT option_id, COUNT(*) AS count FROM votes WHERE poll_id = ? AND status = 'yes' GROUP BY option_id")
    .all(pollId) as { option_id: string; count: number }[];

  return new Map(rows.map((row) => [row.option_id, Number(row.count)]));
}

export type VoteBreakdown = {
  yes: number;
  maybe: number;
  no: number;
};

export function getVoteBreakdown(pollId: string): Map<string, VoteBreakdown> {
  const rows = db
    .prepare("SELECT option_id, status, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option_id, status")
    .all(pollId) as { option_id: string; status: VoteStatus; count: number }[];

  const result = new Map<string, VoteBreakdown>();
  for (const row of rows) {
    const current = result.get(row.option_id) ?? { yes: 0, maybe: 0, no: 0 };
    current[row.status] = Number(row.count);
    result.set(row.option_id, current);
  }
  return result;
}

export function getVotesForPoll(pollId: string): Vote[] {
  const rows = db.prepare("SELECT * FROM votes WHERE poll_id = ? ORDER BY created_at ASC").all(pollId) as Record<string, unknown>[];
  return rows.map((row) => ({
    pollId: String(row.poll_id),
    optionId: String(row.option_id),
    userId: String(row.user_id),
    status: String(row.status ?? "yes") as VoteStatus,
    createdAt: String(row.created_at)
  }));
}

export function getVotedUserIds(pollId: string): string[] {
  const rows = db.prepare("SELECT DISTINCT user_id FROM votes WHERE poll_id = ? ORDER BY created_at ASC").all(pollId) as {
    user_id: string;
  }[];
  return rows.map((row) => String(row.user_id));
}

export function getPollByMessageAndOption(messageId: string, optionId: string): { poll: PollWithOptions; option: PollOption } | null {
  const pollRow = db.prepare("SELECT * FROM polls WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined;
  if (!pollRow) {
    return null;
  }

  const poll = getPoll(String(pollRow.id));
  if (!poll) {
    return null;
  }

  const option = poll.options.find((item) => item.id === optionId);
  if (!option) {
    return null;
  }

  return { poll, option };
}

export function getOpenPollsDue(nowIso: string): PollWithOptions[] {
  const rows = db
    .prepare("SELECT id FROM polls WHERE status = 'open' AND deadline <= ? ORDER BY deadline ASC")
    .all(nowIso) as { id: string }[];

  return rows.map((row) => getPoll(row.id)).filter((poll): poll is PollWithOptions => poll !== null);
}

export function getOpenPolls(): PollWithOptions[] {
  const rows = db.prepare("SELECT id FROM polls WHERE status = 'open' ORDER BY deadline ASC").all() as { id: string }[];
  return rows.map((row) => getPoll(row.id)).filter((poll): poll is PollWithOptions => poll !== null);
}

export function closePoll(pollId: string, status: PollStatus = "closed"): void {
  db.prepare("UPDATE polls SET status = ?, closed_at = ? WHERE id = ?").run(status, new Date().toISOString(), pollId);
}

export function extendPoll(pollId: string, deadlineIso: string): void {
  db.prepare("UPDATE polls SET deadline = ?, status = 'open', closed_at = NULL WHERE id = ?").run(deadlineIso, pollId);
}

export function setRemindedHours(pollId: string, hours: number[]): void {
  db.prepare("UPDATE polls SET reminded_hours = ? WHERE id = ?").run(JSON.stringify(hours), pollId);
}

export function setRemindedMinutes(pollId: string, minutes: number[]): void {
  db.prepare("UPDATE polls SET reminded_minutes = ? WHERE id = ?").run(JSON.stringify(minutes), pollId);
}

export function deletePoll(pollId: string): void {
  db.prepare("DELETE FROM polls WHERE id = ?").run(pollId);
}
