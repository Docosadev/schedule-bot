import type { VoteStatus } from "./types.js";

export const VOTE_EMOJIS: Record<VoteStatus, string> = {
  yes: "⭕",
  no: "❌",
  maybe: "🔺"
};

export const VOTE_LABELS: Record<VoteStatus, string> = {
  yes: "〇",
  no: "✕",
  maybe: "△"
};

export const VOTE_MEANINGS: Record<VoteStatus, string> = {
  yes: "参加",
  no: "不参加",
  maybe: "未定（行けたら行く）"
};

export function formatVoteDefinitions(withEmoji = false): string {
  const prefix = (status: VoteStatus) => (withEmoji ? `${VOTE_EMOJIS[status]} ` : "");
  const label = (status: VoteStatus) => (withEmoji ? "" : `${VOTE_LABELS[status]} `);
  return `${prefix("yes")}${label("yes")}${VOTE_MEANINGS.yes} / ${prefix("no")}${label("no")}${VOTE_MEANINGS.no} / ${prefix("maybe")}${label("maybe")}${VOTE_MEANINGS.maybe}`;
}

export function statusFromEmoji(emoji: string): VoteStatus | null {
  const entry = Object.entries(VOTE_EMOJIS).find(([, value]) => value === emoji);
  return entry ? (entry[0] as VoteStatus) : null;
}
