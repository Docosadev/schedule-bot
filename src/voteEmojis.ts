import type { VoteStatus } from "./types.js";

export const VOTE_EMOJIS: Record<VoteStatus, string> = {
  yes: "⭕",
  no: "❌",
  maybe: "🔺"
};

export const VOTE_LABELS: Record<VoteStatus, string> = {
  yes: "○",
  no: "×",
  maybe: "△"
};

export function statusFromEmoji(emoji: string): VoteStatus | null {
  const entry = Object.entries(VOTE_EMOJIS).find(([, value]) => value === emoji);
  return entry ? (entry[0] as VoteStatus) : null;
}

