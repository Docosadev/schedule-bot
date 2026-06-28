import sharp from "sharp";
import type { PollWithOptions, Vote } from "./types.js";
import { VOTE_LABELS } from "./voteEmojis.js";

export type MatrixParticipant = {
  userId: string;
  displayName: string;
};

const STATUS_STYLES = {
  yes: { label: VOTE_LABELS.yes, color: "#1a7f37", background: "#dafbe1" },
  no: { label: VOTE_LABELS.no, color: "#cf222e", background: "#ffebe9" },
  maybe: { label: VOTE_LABELS.maybe, color: "#9a6700", background: "#fff8c5" }
} as const;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function splitOptionLabel(label: string): [string, string] {
  const [date, ...timeParts] = label.split(" ");
  return [date ?? label, timeParts.join(" ")];
}

export async function buildResultMatrixImage(
  poll: PollWithOptions,
  participants: MatrixParticipant[],
  votes: Vote[]
): Promise<Buffer> {
  const margin = 28;
  const nameColumnWidth = 220;
  const optionColumnWidth = 176;
  const titleHeight = 62;
  const headerHeight = 84;
  const rowHeight = 44;
  const footerHeight = 26;
  const rowCount = Math.max(participants.length, 1);
  const tableWidth = nameColumnWidth + optionColumnWidth * poll.options.length;
  const width = margin * 2 + tableWidth;
  const height = margin * 2 + titleHeight + headerHeight + rowHeight * rowCount + footerHeight;
  const tableX = margin;
  const tableY = margin + titleHeight;
  const voteMap = new Map(votes.map((vote) => [`${vote.optionId}:${vote.userId}`, vote.status]));

  const optionHeaders = poll.options
    .map((option, index) => {
      const x = tableX + nameColumnWidth + optionColumnWidth * index;
      const [date, time] = splitOptionLabel(option.label);
      return `
        <rect x="${x}" y="${tableY}" width="${optionColumnWidth}" height="${headerHeight}" fill="#f6f8fa" stroke="#d0d7de"/>
        <text x="${x + optionColumnWidth / 2}" y="${tableY + 33}" text-anchor="middle" class="header">${escapeXml(date)}</text>
        <text x="${x + optionColumnWidth / 2}" y="${tableY + 58}" text-anchor="middle" class="subheader">${escapeXml(time)}</text>
      `;
    })
    .join("");

  const rows =
    participants.length > 0
      ? participants
          .map((participant, rowIndex) => {
            const y = tableY + headerHeight + rowHeight * rowIndex;
            const cells = poll.options
              .map((option, optionIndex) => {
                const x = tableX + nameColumnWidth + optionColumnWidth * optionIndex;
                const status = voteMap.get(`${option.id}:${participant.userId}`);
                const style = status ? STATUS_STYLES[status] : null;
                return `
                  <rect x="${x}" y="${y}" width="${optionColumnWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
                  ${
                    style
                      ? `<circle cx="${x + optionColumnWidth / 2}" cy="${y + rowHeight / 2}" r="15" fill="${style.background}"/>
                         <text x="${x + optionColumnWidth / 2}" y="${y + rowHeight / 2 + 7}" text-anchor="middle" class="mark" fill="${style.color}">${style.label}</text>`
                      : `<text x="${x + optionColumnWidth / 2}" y="${y + rowHeight / 2 + 6}" text-anchor="middle" class="empty">-</text>`
                  }
                `;
              })
              .join("");

            return `
              <rect x="${tableX}" y="${y}" width="${nameColumnWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
              <text x="${tableX + 14}" y="${y + rowHeight / 2 + 6}" class="name">${escapeXml(truncate(participant.displayName, 18))}</text>
              ${cells}
            `;
          })
          .join("")
      : `
        <rect x="${tableX}" y="${tableY + headerHeight}" width="${tableWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
        <text x="${tableX + tableWidth / 2}" y="${tableY + headerHeight + rowHeight / 2 + 6}" text-anchor="middle" class="empty">まだ誰も投票していません</text>
      `;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <style>
        .title { font: 700 28px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #24292f; }
        .caption { font: 500 14px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #57606a; }
        .header { font: 700 18px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #24292f; }
        .subheader { font: 600 16px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #57606a; }
        .name { font: 600 17px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #24292f; }
        .mark { font: 800 25px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; }
        .empty { font: 600 17px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", "Segoe UI", sans-serif; fill: #8c959f; }
      </style>
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="${margin}" y="${margin + 28}" class="title">${escapeXml(truncate(`日程調整結果: ${poll.title}`, 32))}</text>
      <text x="${margin}" y="${margin + 52}" class="caption">${VOTE_LABELS.yes}=参加可 / ${VOTE_LABELS.no}=不可 / ${VOTE_LABELS.maybe}=調整可</text>
      <rect x="${tableX}" y="${tableY}" width="${nameColumnWidth}" height="${headerHeight}" fill="#f6f8fa" stroke="#d0d7de"/>
      <text x="${tableX + 14}" y="${tableY + 50}" class="header">投票者</text>
      ${optionHeaders}
      ${rows}
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
