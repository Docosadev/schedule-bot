import { EmbedBuilder } from "discord.js";
import { formatDeadline } from "./dateUtils.js";
import { getVoteBreakdown, getVoteCounts, getVotesForPoll } from "./db.js";
import { formatReminderMinutes, parseReminderMinutesJson } from "./reminders.js";
import type { PollOption, PollWithOptions, VoteStatus } from "./types.js";
import { formatVoteDefinitions, VOTE_LABELS, VOTE_MEANINGS } from "./voteEmojis.js";

export async function buildPollEmbed(poll: PollWithOptions): Promise<EmbedBuilder> {
  const breakdown = await getVoteBreakdown(poll.id);

  const statusLabel = poll.status === "open" ? "受付中" : poll.status === "closed" ? "締切済み" : "キャンセル済み";
  const visibilityLabel = poll.anonymous ? "匿名表示" : "投票者確認可";
  const fields = poll.options.map((option) => {
    const counts = breakdown.get(option.id) ?? { yes: 0, maybe: 0, no: 0 };
    return {
      name: `${option.position}. ${option.label}`,
      value: `${VOTE_LABELS.yes} ${VOTE_MEANINGS.yes}: ${counts.yes} / ${VOTE_LABELS.no} ${VOTE_MEANINGS.no}: ${counts.no} / ${VOTE_LABELS.maybe} ${VOTE_MEANINGS.maybe}: ${counts.maybe}`,
      inline: false
    };
  });

  return new EmbedBuilder()
    .setTitle(`日程調整: ${poll.title}`)
    .setColor(poll.status === "open" ? 0x2f80ed : 0x828282)
    .setDescription("候補ごとのメッセージにリアクションするのじゃ。予定が変わったら押し直してよいぞ。")
    .addFields(
      { name: "締切", value: formatDeadline(poll.deadline), inline: true },
      { name: "表示", value: visibilityLabel, inline: true },
      { name: "状態", value: statusLabel, inline: true },
      ...fields
    )
    .setFooter({ text: `ID: ${poll.id}` });
}

export function buildPollHeaderMessage(poll: PollWithOptions): string {
  return [
    `# **日程調整: ${poll.title}**`,
    `締切: ${formatDeadline(poll.deadline)}`,
    `ID: ${poll.id}`,
    "",
    "@everyone",
    "下記の候補日に、参加できるかをリアクションで教えてほしいのじゃ。",
    formatVoteDefinitions(true),
    "予定が変わったら、リアクションを押し直してよいぞ。"
  ].join("\n");
}

export function buildOptionMessage(option: PollOption, poll: PollWithOptions): string {
  return `> ## ${option.label}`;
}

export function buildVotedMembersMessage(names: string[]): string {
  return `投票済み：${names.length ? names.join(", ") : "まだ誰も投票しておらんようじゃ。"}`;
}

export async function buildResultMessage(poll: PollWithOptions, leadingMention?: string): Promise<string> {
  const counts = await getVoteCounts(poll.id);
  const ranked = [...poll.options]
    .map((option) => ({ option, count: counts.get(option.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.option.position - b.option.position);

  const topCount = ranked[0]?.count ?? 0;
  const winners = topCount > 0 ? ranked.filter((item) => item.count === topCount) : [];
  const mentions = [leadingMention, poll.notifyTarget].filter((mention): mention is string => Boolean(mention)).join("\n");
  const winnerLines =
    winners.length > 0
      ? winners.map((item) => `> ## ${item.option.label}\n${VOTE_LABELS.yes} ${VOTE_MEANINGS.yes} ${item.count}票`)
      : ["まだ投票は入っておらんかったようじゃ。"];

  return [
    mentions,
    `# **日程調整結果: ${poll.title}**`,
    "投票はここで締め切りじゃ。みんな、協力ありがとう。",
    "",
    winners.length > 1 ? "## 実施候補（同票じゃ）" : "## 実施候補",
    ...winnerLines,
    "",
    "くわしい投票状況は、添付の画像にまとめておいたぞ。"
  ].filter((line, index) => index !== 0 || line.length > 0).join("\n");
}

export async function buildVoterList(poll: PollWithOptions): Promise<string> {
  if (poll.anonymous) {
    return "このアンケートは匿名表示モードじゃから、投票者一覧は表示できんのじゃ。";
  }

  const votes = await getVotesForPoll(poll.id);
  const byOption = new Map<string, string[]>();
  for (const vote of votes) {
    const users = byOption.get(vote.optionId) ?? [];
    users.push(`<@${vote.userId}>`);
    byOption.set(vote.optionId, users);
  }

  const lines = poll.options.map((option: PollOption) => {
    const optionVotes = votes.filter((vote) => vote.optionId === option.id);
    const groups: Record<VoteStatus, string[]> = { yes: [], maybe: [], no: [] };
    for (const vote of optionVotes) {
      groups[vote.status].push(`<@${vote.userId}>`);
    }

    return [
      `${option.position}. ${option.label}`,
      `${VOTE_LABELS.yes} ${VOTE_MEANINGS.yes}: ${groups.yes.length ? groups.yes.join(" ") : "なし"}`,
      `${VOTE_LABELS.no} ${VOTE_MEANINGS.no}: ${groups.no.length ? groups.no.join(" ") : "なし"}`,
      `${VOTE_LABELS.maybe} ${VOTE_MEANINGS.maybe}: ${groups.maybe.length ? groups.maybe.join(" ") : "なし"}`
    ].join("\n");
  });

  return [`投票者一覧じゃ: ${poll.title}`, "", ...lines].join("\n\n");
}

export async function buildPollSummary(poll: PollWithOptions): Promise<string> {
  const breakdown = await getVoteBreakdown(poll.id);
  const reminders = parseReminderMinutesJson(poll.reminderMinutes)
    .map(formatReminderMinutes)
    .join(", ");
  const lines = poll.options.map((option) => {
    const counts = breakdown.get(option.id) ?? { yes: 0, maybe: 0, no: 0 };
    return `${option.position}. ${option.label} - ${VOTE_LABELS.yes} ${VOTE_MEANINGS.yes} ${counts.yes} / ${VOTE_LABELS.no} ${VOTE_MEANINGS.no} ${counts.no} / ${VOTE_LABELS.maybe} ${VOTE_MEANINGS.maybe} ${counts.maybe}`;
  });
  return [
    `日程調整じゃ: ${poll.title}`,
    `締切: ${formatDeadline(poll.deadline)}`,
    `リマインド: ${reminders}`,
    `状態: ${poll.status}`,
    `投票の意味: ${formatVoteDefinitions()}`,
    "",
    ...lines
  ].join("\n\n");
}
