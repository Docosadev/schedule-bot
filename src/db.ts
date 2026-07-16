import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Pool, type PoolClient } from "pg";
import { config } from "./config.js";
import type {
  PokemonProduct,
  PokemonProductInput,
  Poll,
  PollOption,
  PollStatus,
  PollWithOptions,
  Vote,
  VoteStatus
} from "./types.js";

export type VoteBreakdown = {
  yes: number;
  maybe: number;
  no: number;
};

export type VoteSnapshot = {
  optionId: string;
  userId: string;
  status: VoteStatus;
};

let sqliteDb: Database.Database | null = null;
let postgresPool: Pool | null = null;

function usePostgres(): boolean {
  return Boolean(config.databaseUrl);
}

function getSqlite(): Database.Database {
  if (!sqliteDb) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    sqliteDb = new Database(config.databasePath);
    sqliteDb.pragma("journal_mode = WAL");
    sqliteDb.pragma("foreign_keys = ON");
  }
  return sqliteDb;
}

function getPostgresPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!postgresPool) {
    postgresPool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      ssl: shouldUseSsl(config.databaseUrl) ? { rejectUnauthorized: false } : undefined
    });
  }
  return postgresPool;
}

function shouldUseSsl(databaseUrl: string): boolean {
  if (databaseUrl.includes("sslmode=disable")) {
    return false;
  }
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

export async function migrate(): Promise<void> {
  if (usePostgres()) {
    await migratePostgres();
    return;
  }
  migrateSqlite();
}

function migrateSqlite(): void {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT,
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

    CREATE TABLE IF NOT EXISTS pokemon_products (
      source_key TEXT NOT NULL,
      product_key TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      price TEXT,
      status TEXT,
      image_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (source_key, product_key)
    );
  `);

  ensureSqliteColumn("votes", "status", "TEXT NOT NULL DEFAULT 'yes'");
  ensureSqliteColumn("poll_options", "message_id", "TEXT");
  ensureSqliteColumn("polls", "parent_channel_id", "TEXT");
  ensureSqliteColumn("polls", "voter_message_id", "TEXT");
  ensureSqliteColumn("polls", "reminder_minutes", "TEXT NOT NULL DEFAULT '[1440]'");
  ensureSqliteColumn("polls", "reminded_minutes", "TEXT NOT NULL DEFAULT '[]'");
}

async function migratePostgres(): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT,
      message_id TEXT,
      voter_message_id TEXT,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      deadline TEXT NOT NULL,
      notify_target TEXT,
      multiple_choice BOOLEAN NOT NULL DEFAULT TRUE,
      anonymous BOOLEAN NOT NULL DEFAULT FALSE,
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

    CREATE TABLE IF NOT EXISTS pokemon_products (
      source_key TEXT NOT NULL,
      product_key TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      price TEXT,
      status TEXT,
      image_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (source_key, product_key)
    );
  `);

  await ensurePostgresColumn("votes", "status", "TEXT NOT NULL DEFAULT 'yes'");
  await ensurePostgresColumn("poll_options", "message_id", "TEXT");
  await ensurePostgresColumn("polls", "parent_channel_id", "TEXT");
  await ensurePostgresColumn("polls", "voter_message_id", "TEXT");
  await ensurePostgresColumn("polls", "reminder_minutes", "TEXT NOT NULL DEFAULT '[1440]'");
  await ensurePostgresColumn("polls", "reminded_minutes", "TEXT NOT NULL DEFAULT '[]'");
}

function ensureSqliteColumn(table: string, column: string, definition: string): void {
  const db = getSqlite();
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensurePostgresColumn(table: string, column: string, definition: string): Promise<void> {
  const result = await getPostgresPool().query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [table, column]
  );
  if (result.rowCount === 0) {
    await getPostgresPool().query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function mapPoll(row: Record<string, unknown>): Poll {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    parentChannelId: row.parent_channel_id ? String(row.parent_channel_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    voterMessageId: row.voter_message_id ? String(row.voter_message_id) : null,
    creatorId: String(row.creator_id),
    title: String(row.title),
    deadline: String(row.deadline),
    notifyTarget: row.notify_target ? String(row.notify_target) : null,
    multipleChoice: toBoolean(row.multiple_choice),
    anonymous: toBoolean(row.anonymous),
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

function mapPokemonProduct(row: Record<string, unknown>): PokemonProduct {
  return {
    sourceKey: String(row.source_key),
    productKey: String(row.product_key),
    name: String(row.name),
    url: String(row.url),
    price: row.price ? String(row.price) : null,
    status: row.status ? String(row.status) : null,
    imageUrl: row.image_url ? String(row.image_url) : null,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at)
  };
}

function pollParams(poll: Poll): Record<string, unknown> {
  return {
    ...poll,
    multipleChoice: poll.multipleChoice ? 1 : 0,
    anonymous: poll.anonymous ? 1 : 0
  };
}

function pollValues(poll: Poll): unknown[] {
  return [
    poll.id,
    poll.guildId,
    poll.channelId,
    poll.parentChannelId,
    poll.messageId,
    poll.voterMessageId,
    poll.creatorId,
    poll.title,
    poll.deadline,
    poll.notifyTarget,
    poll.multipleChoice,
    poll.anonymous,
    poll.reminderMinutes,
    poll.remindedMinutes,
    poll.status,
    poll.remindedHours,
    poll.createdAt,
    poll.closedAt
  ];
}

async function withPostgresTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createPoll(poll: Poll, options: PollOption[]): Promise<void> {
  if (usePostgres()) {
    await withPostgresTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO polls (
            id, guild_id, channel_id, parent_channel_id, message_id, voter_message_id, creator_id, title, deadline,
            notify_target, multiple_choice, anonymous, reminder_minutes, reminded_minutes, status, reminded_hours,
            created_at, closed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `,
        pollValues(poll)
      );
      for (const option of options) {
        await client.query(
          `
            INSERT INTO poll_options (id, poll_id, message_id, position, emoji, starts_at, label)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [option.id, option.pollId, option.messageId, option.position, option.emoji, option.startsAt, option.label]
        );
      }
    });
    return;
  }

  const db = getSqlite();
  const insertPoll = db.prepare(`
    INSERT INTO polls (
      id, guild_id, channel_id, parent_channel_id, message_id, voter_message_id, creator_id, title, deadline,
      notify_target, multiple_choice, anonymous, reminder_minutes, reminded_minutes, status, reminded_hours,
      created_at, closed_at
    )
    VALUES (
      @id, @guildId, @channelId, @parentChannelId, @messageId, @voterMessageId, @creatorId, @title, @deadline,
      @notifyTarget, @multipleChoice, @anonymous, @reminderMinutes, @remindedMinutes, @status, @remindedHours,
      @createdAt, @closedAt
    )
  `);
  const insertOption = db.prepare(`
    INSERT INTO poll_options (id, poll_id, message_id, position, emoji, starts_at, label)
    VALUES (@id, @pollId, @messageId, @position, @emoji, @startsAt, @label)
  `);

  db.transaction(() => {
    insertPoll.run(pollParams(poll));
    for (const option of options) {
      insertOption.run(option);
    }
  })();
}

export async function updatePollMessageId(pollId: string, messageId: string): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE polls SET message_id = $1 WHERE id = $2", [messageId, pollId]);
    return;
  }
  getSqlite().prepare("UPDATE polls SET message_id = ? WHERE id = ?").run(messageId, pollId);
}

export async function updateVoterMessageId(pollId: string, messageId: string): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE polls SET voter_message_id = $1 WHERE id = $2", [messageId, pollId]);
    return;
  }
  getSqlite().prepare("UPDATE polls SET voter_message_id = ? WHERE id = ?").run(messageId, pollId);
}

export async function updateOptionMessageId(optionId: string, messageId: string): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE poll_options SET message_id = $1 WHERE id = $2", [messageId, optionId]);
    return;
  }
  getSqlite().prepare("UPDATE poll_options SET message_id = ? WHERE id = ?").run(messageId, optionId);
}

export async function getPoll(pollId: string): Promise<PollWithOptions | null> {
  if (usePostgres()) {
    const pollResult = await getPostgresPool().query("SELECT * FROM polls WHERE id = $1", [pollId]);
    if (!pollResult.rows[0]) {
      return null;
    }
    const optionResult = await getPostgresPool().query("SELECT * FROM poll_options WHERE poll_id = $1 ORDER BY position ASC", [
      pollId
    ]);
    return {
      ...mapPoll(pollResult.rows[0]),
      options: optionResult.rows.map(mapOption)
    };
  }

  const pollRow = getSqlite().prepare("SELECT * FROM polls WHERE id = ?").get(pollId) as Record<string, unknown> | undefined;
  if (!pollRow) {
    return null;
  }

  const optionRows = getSqlite()
    .prepare("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC")
    .all(pollId) as Record<string, unknown>[];

  return {
    ...mapPoll(pollRow),
    options: optionRows.map(mapOption)
  };
}

export async function getPollByMessage(messageId: string): Promise<{ poll: PollWithOptions; option: PollOption } | null> {
  const optionRow = usePostgres()
    ? (await getPostgresPool().query("SELECT * FROM poll_options WHERE message_id = $1", [messageId])).rows[0]
    : (getSqlite().prepare("SELECT * FROM poll_options WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined);
  if (!optionRow) {
    return null;
  }

  const poll = await getPoll(String(optionRow.poll_id));
  if (!poll) {
    return null;
  }

  const option = poll.options.find((item) => item.id === optionRow.id);
  if (!option) {
    return null;
  }

  return { poll, option };
}

export async function addVote(poll: Poll, option: PollOption, userId: string, status: VoteStatus = "yes"): Promise<void> {
  const now = new Date().toISOString();
  if (usePostgres()) {
    await withPostgresTransaction(async (client) => {
      await client.query("DELETE FROM votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3", [poll.id, option.id, userId]);
      await client.query("INSERT INTO votes (poll_id, option_id, user_id, status, created_at) VALUES ($1, $2, $3, $4, $5)", [
        poll.id,
        option.id,
        userId,
        status,
        now
      ]);
    });
    return;
  }

  getSqlite().transaction(() => {
    getSqlite().prepare("DELETE FROM votes WHERE poll_id = ? AND option_id = ? AND user_id = ?").run(poll.id, option.id, userId);
    getSqlite()
      .prepare("INSERT INTO votes (poll_id, option_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(poll.id, option.id, userId, status, now);
  })();
}

export async function removeVoteForStatus(
  pollId: string,
  optionId: string,
  userId: string,
  status: VoteStatus
): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("DELETE FROM votes WHERE poll_id = $1 AND option_id = $2 AND user_id = $3 AND status = $4", [
      pollId,
      optionId,
      userId,
      status
    ]);
    return;
  }
  getSqlite()
    .prepare("DELETE FROM votes WHERE poll_id = ? AND option_id = ? AND user_id = ? AND status = ?")
    .run(pollId, optionId, userId, status);
}

export async function replaceVotesForPoll(pollId: string, votes: VoteSnapshot[]): Promise<void> {
  const now = new Date().toISOString();
  const uniqueVotes = [...new Map(votes.map((vote) => [`${vote.optionId}:${vote.userId}`, vote])).values()];

  if (usePostgres()) {
    await withPostgresTransaction(async (client) => {
      await client.query("DELETE FROM votes WHERE poll_id = $1", [pollId]);
      for (const vote of uniqueVotes) {
        await client.query(
          "INSERT INTO votes (poll_id, option_id, user_id, status, created_at) VALUES ($1, $2, $3, $4, $5)",
          [pollId, vote.optionId, vote.userId, vote.status, now]
        );
      }
    });
    return;
  }

  const insertVote = getSqlite().prepare(
    "INSERT INTO votes (poll_id, option_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  getSqlite().transaction(() => {
    getSqlite().prepare("DELETE FROM votes WHERE poll_id = ?").run(pollId);
    for (const vote of uniqueVotes) {
      insertVote.run(pollId, vote.optionId, vote.userId, vote.status, now);
    }
  })();
}

export async function getVoteCounts(pollId: string): Promise<Map<string, number>> {
  const rows = usePostgres()
    ? (
        await getPostgresPool().query(
          "SELECT option_id, COUNT(*) AS count FROM votes WHERE poll_id = $1 AND status = 'yes' GROUP BY option_id",
          [pollId]
        )
      ).rows
    : (getSqlite()
        .prepare("SELECT option_id, COUNT(*) AS count FROM votes WHERE poll_id = ? AND status = 'yes' GROUP BY option_id")
        .all(pollId) as { option_id: string; count: number }[]);

  return new Map(rows.map((row) => [String(row.option_id), Number(row.count)]));
}

export async function getVoteBreakdown(pollId: string): Promise<Map<string, VoteBreakdown>> {
  const rows = usePostgres()
    ? (
        await getPostgresPool().query(
          "SELECT option_id, status, COUNT(*) AS count FROM votes WHERE poll_id = $1 GROUP BY option_id, status",
          [pollId]
        )
      ).rows
    : (getSqlite()
        .prepare("SELECT option_id, status, COUNT(*) AS count FROM votes WHERE poll_id = ? GROUP BY option_id, status")
        .all(pollId) as { option_id: string; status: VoteStatus; count: number }[]);

  const result = new Map<string, VoteBreakdown>();
  for (const row of rows as { option_id: string; status: VoteStatus; count: number }[]) {
    const current = result.get(row.option_id) ?? { yes: 0, maybe: 0, no: 0 };
    current[row.status] = Number(row.count);
    result.set(row.option_id, current);
  }
  return result;
}

export async function getVotesForPoll(pollId: string): Promise<Vote[]> {
  const rows = usePostgres()
    ? (await getPostgresPool().query("SELECT * FROM votes WHERE poll_id = $1 ORDER BY created_at ASC", [pollId])).rows
    : (getSqlite().prepare("SELECT * FROM votes WHERE poll_id = ? ORDER BY created_at ASC").all(pollId) as Record<string, unknown>[]);

  return rows.map((row: Record<string, unknown>) => ({
    pollId: String(row.poll_id),
    optionId: String(row.option_id),
    userId: String(row.user_id),
    status: String(row.status ?? "yes") as VoteStatus,
    createdAt: String(row.created_at)
  }));
}

export async function getVotedUserIds(pollId: string): Promise<string[]> {
  const rows = usePostgres()
    ? (
        await getPostgresPool().query("SELECT DISTINCT user_id, MIN(created_at) AS first_vote FROM votes WHERE poll_id = $1 GROUP BY user_id ORDER BY first_vote ASC", [
          pollId
        ])
      ).rows
    : (getSqlite()
        .prepare("SELECT DISTINCT user_id FROM votes WHERE poll_id = ? ORDER BY created_at ASC")
        .all(pollId) as { user_id: string }[]);

  return rows.map((row) => String(row.user_id));
}

async function getPollsFromRows(rows: { id: string }[]): Promise<PollWithOptions[]> {
  const polls: PollWithOptions[] = [];
  for (const row of rows) {
    const poll = await getPoll(row.id);
    if (poll) {
      polls.push(poll);
    }
  }
  return polls;
}

export async function getOpenPollsDue(nowIso: string): Promise<PollWithOptions[]> {
  const rows = usePostgres()
    ? (await getPostgresPool().query("SELECT id FROM polls WHERE status = 'open' AND deadline <= $1 ORDER BY deadline ASC", [nowIso])).rows
    : (getSqlite()
        .prepare("SELECT id FROM polls WHERE status = 'open' AND deadline <= ? ORDER BY deadline ASC")
        .all(nowIso) as { id: string }[]);

  return getPollsFromRows(rows as { id: string }[]);
}

export async function getOpenPolls(): Promise<PollWithOptions[]> {
  const rows = usePostgres()
    ? (await getPostgresPool().query("SELECT id FROM polls WHERE status = 'open' ORDER BY deadline ASC")).rows
    : (getSqlite().prepare("SELECT id FROM polls WHERE status = 'open' ORDER BY deadline ASC").all() as { id: string }[]);

  return getPollsFromRows(rows as { id: string }[]);
}

export async function closePoll(pollId: string, status: PollStatus = "closed"): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE polls SET status = $1, closed_at = $2 WHERE id = $3", [
      status,
      new Date().toISOString(),
      pollId
    ]);
    return;
  }
  getSqlite().prepare("UPDATE polls SET status = ?, closed_at = ? WHERE id = ?").run(status, new Date().toISOString(), pollId);
}

export async function extendPoll(pollId: string, deadlineIso: string): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE polls SET deadline = $1, status = 'open', closed_at = NULL WHERE id = $2", [
      deadlineIso,
      pollId
    ]);
    return;
  }
  getSqlite().prepare("UPDATE polls SET deadline = ?, status = 'open', closed_at = NULL WHERE id = ?").run(deadlineIso, pollId);
}

export async function setRemindedMinutes(pollId: string, minutes: number[]): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("UPDATE polls SET reminded_minutes = $1 WHERE id = $2", [JSON.stringify(minutes), pollId]);
    return;
  }
  getSqlite().prepare("UPDATE polls SET reminded_minutes = ? WHERE id = ?").run(JSON.stringify(minutes), pollId);
}

export async function deletePoll(pollId: string): Promise<void> {
  if (usePostgres()) {
    await getPostgresPool().query("DELETE FROM polls WHERE id = $1", [pollId]);
    return;
  }
  getSqlite().prepare("DELETE FROM polls WHERE id = ?").run(pollId);
}

export async function getPokemonProductsBySource(sourceKey: string): Promise<PokemonProduct[]> {
  if (usePostgres()) {
    const result = await getPostgresPool().query("SELECT * FROM pokemon_products WHERE source_key = $1", [sourceKey]);
    return result.rows.map(mapPokemonProduct);
  }

  const rows = getSqlite().prepare("SELECT * FROM pokemon_products WHERE source_key = ?").all(sourceKey) as Record<string, unknown>[];
  return rows.map(mapPokemonProduct);
}

export async function recordPokemonProductSnapshot(sourceKey: string, products: PokemonProductInput[]): Promise<PokemonProductInput[]> {
  const existingProducts = await getPokemonProductsBySource(sourceKey);
  const existingKeys = new Set(existingProducts.map((product) => product.productKey));
  const isInitialSnapshot = existingKeys.size === 0;
  const now = new Date().toISOString();
  const uniqueProducts = [...new Map(products.map((product) => [product.productKey, product])).values()];
  const newProducts = uniqueProducts.filter((product) => !existingKeys.has(product.productKey));

  if (usePostgres()) {
    await withPostgresTransaction(async (client) => {
      for (const product of newProducts) {
        await client.query(
          `
            INSERT INTO pokemon_products (
              source_key, product_key, name, url, price, status, image_url, first_seen_at, last_seen_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
            ON CONFLICT (source_key, product_key) DO NOTHING
          `,
          [
            product.sourceKey,
            product.productKey,
            product.name,
            product.url,
            product.price,
            product.status,
            product.imageUrl,
            now
          ]
        );
      }
    });
  } else {
    const insert = getSqlite().prepare(`
      INSERT INTO pokemon_products (
        source_key, product_key, name, url, price, status, image_url, first_seen_at, last_seen_at
      )
      VALUES (@sourceKey, @productKey, @name, @url, @price, @status, @imageUrl, @seenAt, @seenAt)
      ON CONFLICT(source_key, product_key) DO NOTHING
    `);

    getSqlite().transaction(() => {
      for (const product of newProducts) {
        insert.run({ ...product, seenAt: now });
      }
    })();
  }

  return isInitialSnapshot ? [] : newProducts;
}
