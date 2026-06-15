/**
 * mellow-wet.jp サイトクローラ
 * ------------------------------------------------------------------
 * サイト全ページを取得し、テキスト・価格・タイトルを site-content.json に保存します。
 * これは「最新内容を機械的に集める」だけの処理です（AIは使いません）。
 * 集めたコーパスを基に faq.json を作り直す手順は tools/regen-faq-prompt.md を参照。
 *
 * 使い方:  node tools/crawl-site.mjs
 * 依存: なし（Node 18+ の標準 fetch を使用）
 * ------------------------------------------------------------------
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://mellow-wet.jp/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "site-content.json");
const DELAY_MS = 300;       // 各リクエストの間隔（サーバーに優しく）
const MAX_PAGES = 200;      // 安全のための上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mellow-chat-crawler/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text(); // サイトはUTF-8なので変換不要
}

// HTML本文をプレーンテキスト化
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t　]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pick(re, html) {
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

function extractPrices(text) {
  const set = new Set();
  const re = /(?:¥|￥)\s?[0-9,]+|[0-9][0-9,]*\s?円/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[0].replace(/\s/g, "");
    if (!/^0+円?$/.test(v)) set.add(v); // 「0円」は除外
  }
  return [...set];
}

async function main() {
  console.log("トップページを取得中…");
  const home = await getHtml(BASE);

  // 主要情報ページ（トップに直リンクが無いものも明示的に対象に含める）
  const pages = new Set([
    "index.html", "aboutus.html", "contact.html", "franchise.html",
    "order.html", "measure.html", "option.html", "shop.html", "privacypolicy.html",
  ]);

  // トップ + aboutus のナビから内部リンクを収集（item/*.html と .html ページ）
  const navSources = [home];
  try { navSources.push(await getHtml(BASE + "aboutus.html")); } catch { /* skip */ }
  for (const src of navSources) {
    for (const m of src.matchAll(/href="([^"]+)"/gi)) {
      const h = m[1];
      if (/^item\/[\w-]+\.html$/i.test(h)) pages.add(h);
      else if (/^[\w-]+\.html$/i.test(h)) pages.add(h);
    }
  }
  const list = [...pages].slice(0, MAX_PAGES);
  console.log(`対象ページ: ${list.length}件`);

  const results = [];
  let i = 0;
  for (const path of list) {
    i++;
    const url = BASE + path;
    try {
      const html = await getHtml(url);
      const title = pick(/<title>([^<]*)<\/title>/i, html);
      const description = pick(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i, html);
      const text = htmlToText(html);
      results.push({ url, path, title, description, prices: extractPrices(text), text });
      console.log(`  [${i}/${list.length}] OK  ${path}  (${text.length}字, 価格${extractPrices(text).length}件)`);
    } catch (e) {
      console.warn(`  [${i}/${list.length}] NG  ${path}  → ${e.message}`);
      results.push({ url, path, error: String(e.message) });
    }
    await sleep(DELAY_MS);
  }

  const payload = {
    crawledAt: new Date().toISOString(),
    base: BASE,
    pageCount: results.length,
    pages: results,
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\n完了: ${results.length}ページを ${OUT} に保存しました。`);
}

main().catch((e) => {
  console.error("クロール失敗:", e);
  process.exit(1);
});
