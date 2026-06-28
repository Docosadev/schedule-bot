import { randomBytes } from "node:crypto";

export type WebSession = {
  token: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  expiresAt: number;
};

const sessions = new Map<string, WebSession>();
const ttlMs = 30 * 60 * 1000;

export function createWebSession(input: Omit<WebSession, "token" | "expiresAt">): WebSession {
  cleanupExpiredSessions();

  const session: WebSession = {
    ...input,
    token: randomBytes(24).toString("hex"),
    expiresAt: Date.now() + ttlMs
  };

  sessions.set(session.token, session);
  return session;
}

export function getWebSession(token: string): WebSession | null {
  cleanupExpiredSessions();

  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function consumeWebSession(token: string): void {
  sessions.delete(token);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}
