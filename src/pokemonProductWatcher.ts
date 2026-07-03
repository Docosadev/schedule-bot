import { EmbedBuilder, type GuildTextBasedChannel } from "discord.js";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { config } from "./config.js";
import { recordPokemonProductSnapshot } from "./db.js";
import { isGuildTextChannel } from "./pollService.js";
import type { PokemonProductInput } from "./types.js";

type ProductSource = {
  key: string;
  label: string;
  url: string;
};

const PRODUCT_SOURCES: ProductSource[] = [
  {
    key: "booster-packs",
    label: "拡張パック",
    url: "https://www.pokemoncenter-online.com/pokemon-card-game/booster-packs/"
  },
  {
    key: "battle-decks",
    label: "構築デッキ",
    url: "https://www.pokemoncenter-online.com/pokemon-card-game/battle-decks/"
  }
];

const PRODUCT_ORIGIN = "https://www.pokemoncenter-online.com";
const MAX_NOTIFY_PRODUCTS_PER_SOURCE = 10;
const PRODUCT_EMBED_COLOR = 0x3b4cca;
const executedSlots = new Set<string>();

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toAbsoluteUrl(value: string): string {
  return new URL(decodeHtmlEntities(value), PRODUCT_ORIGIN).toString();
}

function extractAttribute(tag: string, attribute: string): string | null {
  const match = tag.match(new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtmlEntities(match[1]) : null;
}

function normalizeProductName(text: string): string {
  return text
    .replace(/[\d,]+\s*円/g, "")
    .replace(/(?:品切れ|予約)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractImageUrl(anchorHtml: string): string | null {
  const imgMatch = anchorHtml.match(/<img\b[^>]*>/i);
  if (!imgMatch) {
    return null;
  }
  const src = extractAttribute(imgMatch[0], "src") ?? extractAttribute(imgMatch[0], "data-src");
  return src ? toAbsoluteUrl(src) : null;
}

function extractProductCards(html: string): string[] {
  const cards: string[] = [];
  const cardPattern = /<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = cardPattern.exec(html)) !== null) {
    cards.push(match[0]);
  }
  return cards;
}

function parseProductCard(source: ProductSource, cardHtml: string): PokemonProductInput | null {
  const productId = extractAttribute(cardHtml, "data-pid");
  const href = cardHtml.match(/<a\b[^>]*href=["']([^"']+\.html)["'][^>]*>/i)?.[1];
  const imgMatch = cardHtml.match(/<img\b[^>]*>/i);
  const imageUrl = imgMatch ? extractImageUrl(imgMatch[0]) : null;
  const name =
    (imgMatch ? extractAttribute(imgMatch[0], "alt") : null) ??
    stripTags(cardHtml.match(/<p\b[^>]*class=["'][^"']*\btxt\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");

  if (!href || !name.includes("ポケモンカードゲーム")) {
    return null;
  }

  const url = toAbsoluteUrl(href);
  const priceText = stripTags(cardHtml.match(/<p\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const price = priceText.match(/[\d,]+\s*円/)?.[0].replace(/\s+/g, " ") ?? null;
  const statuses = ["品切れ", "予約"].filter((status) => cardHtml.includes(status));

  return {
    sourceKey: source.key,
    productKey: productId ?? url,
    name,
    url,
    price,
    status: statuses.length ? statuses.join(" / ") : null,
    imageUrl
  };
}

function parseProducts(source: ProductSource, html: string): PokemonProductInput[] {
  const cardProducts = extractProductCards(html)
    .map((card) => parseProductCard(source, card))
    .filter((product): product is PokemonProductInput => product !== null);
  if (cardProducts.length > 0) {
    return cardProducts;
  }

  const products = new Map<string, PokemonProductInput>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = extractAttribute(match[1], "href");
    if (!href) {
      continue;
    }

    const url = toAbsoluteUrl(href);
    const text = stripTags(match[2]);
    const name = normalizeProductName(text);
    if (!url.includes(PRODUCT_ORIGIN) || !name.includes("ポケモンカードゲーム")) {
      continue;
    }
    if (url === source.url || url.includes("/pokemon-card-game/")) {
      continue;
    }

    const price = text.match(/[\d,]+\s*円/)?.[0].replace(/\s+/g, " ") ?? null;
    const statuses = ["品切れ", "予約"].filter((status) => text.includes(status));
    const status = statuses.length ? statuses.join(" / ") : null;

    products.set(url, {
      sourceKey: source.key,
      productKey: url,
      name,
      url,
      price,
      status,
      imageUrl: extractImageUrl(match[2])
    });
  }

  return [...products.values()];
}

async function fetchProducts(source: ProductSource): Promise<PokemonProductInput[]> {
  const response = await fetch(source.url, {
    headers: {
      "User-Agent": "DiscordBot product watcher (+https://www.pokemoncenter-online.com/)"
    }
  });
  if (!response.ok) {
    throw new Error(`Pokemon Center fetch failed: ${source.key} ${response.status}`);
  }

  return parseProducts(source, await response.text());
}

function isReservationProduct(product: PokemonProductInput): boolean {
  return product.status?.includes("予約") ?? false;
}

function buildProductMessage(source: ProductSource, product: PokemonProductInput): string {
  if (isReservationProduct(product)) {
    return `おおっ！${source.label}の予約商品が追加されたようじゃ。`;
  }
  return `おおっ！${source.label}の新商品が追加されたようじゃ。`;
}

function buildProductEmbed(source: ProductSource, product: PokemonProductInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(product.name)
    .setURL(product.url)
    .setColor(PRODUCT_EMBED_COLOR)
    .setTimestamp(new Date())
    .addFields(
      { name: "カテゴリ", value: source.label, inline: true },
      { name: "価格", value: product.price ?? "不明", inline: true },
      { name: "状態", value: product.status ?? "通常表示", inline: true },
      { name: "商品ページ", value: product.url }
    );

  if (product.imageUrl) {
    embed.setImage(product.imageUrl);
  }

  return embed;
}

async function notifyNewProducts(channel: GuildTextBasedChannel, source: ProductSource, products: PokemonProductInput[]): Promise<void> {
  const targets = products.slice(0, MAX_NOTIFY_PRODUCTS_PER_SOURCE);
  for (const product of targets) {
    await channel.send({
      content: buildProductMessage(source, product),
      embeds: [buildProductEmbed(source, product)]
    });
  }

  const remaining = products.length - targets.length;
  if (remaining > 0) {
    await channel.send(`${source.label}でさらに${remaining}件の新商品を検知しました: ${source.url}`);
  }
}

export async function checkPokemonProducts(clientChannelsFetch: (channelId: string) => Promise<unknown>): Promise<void> {
  const channelId = config.pokemonProductNotifyChannelId;
  if (!channelId) {
    return;
  }

  const channel = await clientChannelsFetch(channelId).catch(() => null);
  if (!isGuildTextChannel(channel)) {
    console.warn("pokemon product notify channel was not found or is not text-based", { channelId });
    return;
  }

  for (const source of PRODUCT_SOURCES) {
    try {
      const products = await fetchProducts(source);
      if (products.length === 0) {
        console.warn("no pokemon products parsed", { sourceKey: source.key });
        continue;
      }

      const newProducts = await recordPokemonProductSnapshot(source.key, products);
      if (newProducts.length > 0) {
        await notifyNewProducts(channel, source, newProducts);
      }
    } catch (error) {
      console.error("pokemon product check failed", { sourceKey: source.key }, error);
    }
  }
}

export async function checkPokemonProductsIfDue(clientChannelsFetch: (channelId: string) => Promise<unknown>): Promise<void> {
  if (!config.pokemonProductNotifyChannelId) {
    return;
  }

  const now = toZonedTime(new Date(), config.timezone);
  const today = format(now, "yyyy-MM-dd");
  const currentTime = format(now, "HH:mm");
  if (!config.pokemonProductCheckTimes.includes(currentTime)) {
    return;
  }

  const slot = `${today} ${currentTime}`;
  if (executedSlots.has(slot)) {
    return;
  }

  executedSlots.add(slot);
  await checkPokemonProducts(clientChannelsFetch);
}
