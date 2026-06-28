import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const FONT_FILES = {
  regular: require.resolve("@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf"),
  bold: require.resolve("@expo-google-fonts/noto-sans-jp/700Bold/NotoSansJP_700Bold.ttf")
};

type TextLayer = {
  text: string;
  left: number;
  top: number;
  width?: number;
  align?: "left" | "center";
  fontSize: number;
  color?: string;
  weight?: "regular" | "bold";
};

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

async function renderTextLayer(layer: TextLayer): Promise<{ input: Buffer; left: number; top: number }> {
  const renderer = sharp({
    text: {
      text: `<span foreground="${layer.color ?? "#24292f"}">${escapeXml(layer.text)}</span>`,
      font: `Noto Sans JP ${layer.fontSize}`,
      fontfile: FONT_FILES[layer.weight ?? "regular"],
      width: layer.width,
      align: layer.align === "center" ? "center" : "left",
      rgba: true,
      wrap: "char"
    }
  }).png();
  const metadata = await renderer.metadata();
  const input = await renderer.toBuffer();
  const renderedWidth = metadata.width ?? layer.width ?? 0;
  const left =
    layer.align === "center" && layer.width
      ? Math.round(layer.left + Math.max(0, layer.width - renderedWidth) / 2)
      : Math.round(layer.left);

  return { input, left, top: Math.round(layer.top) };
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
  const textLayers: TextLayer[] = [
    {
      text: truncate(`日程調整結果: ${poll.title}`, 32),
      left: margin,
      top: margin + 2,
      fontSize: 28,
      weight: "bold"
    },
    {
      text: `${VOTE_LABELS.yes}=参加可 / ${VOTE_LABELS.no}=不可 / ${VOTE_LABELS.maybe}=調整可`,
      left: margin,
      top: margin + 40,
      fontSize: 14,
      color: "#57606a"
    },
    {
      text: "投票者",
      left: tableX + 14,
      top: tableY + 32,
      fontSize: 18,
      weight: "bold"
    }
  ];

  const optionHeaders = poll.options
    .map((option, index) => {
      const x = tableX + nameColumnWidth + optionColumnWidth * index;
      const [date, time] = splitOptionLabel(option.label);
      textLayers.push(
        {
          text: date,
          left: x,
          top: tableY + 18,
          width: optionColumnWidth,
          align: "center",
          fontSize: 18,
          weight: "bold"
        },
        {
          text: time,
          left: x,
          top: tableY + 47,
          width: optionColumnWidth,
          align: "center",
          fontSize: 16,
          color: "#57606a",
          weight: "bold"
        }
      );
      return `
        <rect x="${x}" y="${tableY}" width="${optionColumnWidth}" height="${headerHeight}" fill="#f6f8fa" stroke="#d0d7de"/>
      `;
    })
    .join("");

  const rows =
    participants.length > 0
      ? participants
          .map((participant, rowIndex) => {
            const y = tableY + headerHeight + rowHeight * rowIndex;
            textLayers.push({
              text: truncate(participant.displayName, 18),
              left: tableX + 14,
              top: y + 14,
              fontSize: 17,
              weight: "bold"
            });
            const cells = poll.options
              .map((option, optionIndex) => {
                const x = tableX + nameColumnWidth + optionColumnWidth * optionIndex;
                const status = voteMap.get(`${option.id}:${participant.userId}`);
                const style = status ? STATUS_STYLES[status] : null;
                textLayers.push({
                  text: style?.label ?? "-",
                  left: x,
                  top: y + (style ? 8 : 13),
                  width: optionColumnWidth,
                  align: "center",
                  fontSize: style ? 25 : 17,
                  color: style?.color ?? "#8c959f",
                  weight: "bold"
                });
                return `
                  <rect x="${x}" y="${y}" width="${optionColumnWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
                  ${style ? `<circle cx="${x + optionColumnWidth / 2}" cy="${y + rowHeight / 2}" r="15" fill="${style.background}"/>` : ""}
                `;
              })
              .join("");

            return `
              <rect x="${tableX}" y="${y}" width="${nameColumnWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
              ${cells}
            `;
          })
          .join("")
      : (() => {
          textLayers.push({
            text: "まだ誰も投票していません",
            left: tableX,
            top: tableY + headerHeight + 13,
            width: tableWidth,
            align: "center",
            fontSize: 17,
            color: "#8c959f",
            weight: "bold"
          });
          return `
            <rect x="${tableX}" y="${tableY + headerHeight}" width="${tableWidth}" height="${rowHeight}" fill="#ffffff" stroke="#d0d7de"/>
          `;
        })();

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <rect x="${tableX}" y="${tableY}" width="${nameColumnWidth}" height="${headerHeight}" fill="#f6f8fa" stroke="#d0d7de"/>
      ${optionHeaders}
      ${rows}
    </svg>
  `;

  const renderedTextLayers = await Promise.all(textLayers.map(renderTextLayer));
  return sharp(Buffer.from(svg)).composite(renderedTextLayers).png().toBuffer();
}
