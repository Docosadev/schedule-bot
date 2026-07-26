import { createHash, randomBytes } from "node:crypto";
import {
  consumeWebSessionRecord,
  createWebSessionRecord,
  getActiveWebSessionRecord
} from "./db.js";

export type WebSession = {
  token: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  expiresAt: number;
};

const ttlMs = 30 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createWebSession(input: Omit<WebSession, "token" | "expiresAt">): Promise<WebSession> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = now.getTime() + ttlMs;
  await createWebSessionRecord({
    tokenHash: hashToken(token),
    guildId: input.guildId,
    channelId: input.channelId,
    creatorId: input.creatorId,
    expiresAt: new Date(expiresAt).toISOString(),
    consumedAt: null,
    createdAt: now.toISOString()
  });
  return { ...input, token, expiresAt };
}

export async function getWebSession(token: string): Promise<WebSession | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    return null;
  }
  const session = await getActiveWebSessionRecord(hashToken(token));
  if (!session) return null;
  return {
    token,
    guildId: session.guildId,
    channelId: session.channelId,
    creatorId: session.creatorId,
    expiresAt: new Date(session.expiresAt).getTime()
  };
}

export async function consumeWebSession(token: string): Promise<boolean> {
  return consumeWebSessionRecord(hashToken(token));
}
