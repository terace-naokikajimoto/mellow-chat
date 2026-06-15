/**
 * メロー チャット — 未回答ログ収集スクリプト
 * ------------------------------------------------------------------
 * GAS（gas/Code.gs）のエクスポート口から質問ログを取得し、
 * 「答えられなかった／的外れだった」質問を似たもの同士でまとめて
 * tools/unanswered.json に書き出します。AIは使いません（集計のみ）。
 *
 * この出力を tools/grow-faq-prompt.md と一緒に Claude に渡すと、
 * faq.json の更新案（キーワード追加 / 新規Q&A / 対象外）が作れます。
 *
 * 使い方:
 *   MELLOW_LOG_URL="https://script.google.com/macros/s/XXX/exec" \
 *   MELLOW_LOG_TOKEN="（任意・SHARED_TOKENと同じ文字列）" \
 *   node tools/harvest-questions.mjs            # 直近30日
 *   node tools/harvest-questions.mjs --days 60  # 期間を指定
 *   node tools/harvest-questions.mjs --all      # 全期間
 *   node tools/harvest-questions.mjs --url "https://…/exec" --token "…"  # 引数で渡す
 *
 * 依存: なし（Node 18+ の標準 fetch を使用）
 * ------------------------------------------------------------------
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "unanswered.json");
// これ以上似ていれば同じクラスタに束ねる（bi-gram Dice）。
// 表面的な表記ゆれ（「駐車場はありますか」/「駐車場ありますか」≒0.67）を束ねるため低めに設定。
// 漢字↔ひらがなのような文字種違いはここでは束ねきれないが、grow-faq-prompt 側のLLMが
// 意味でクラスタリングし直すので、ここは「明らかな重複を減らす」程度の役割でよい。
const SIM_THRESHOLD = 0.6;

// ---- 引数・環境変数の読み取り --------------------------------------
function parseArgs(argv) {
  const a = { days: 30, all: false, url: "", token: "" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--all") a.all = true;
    else if (k === "--days") a.days = parseInt(argv[++i], 10) || 30;
    else if (k === "--url") a.url = argv[++i] || "";
    else if (k === "--token") a.token = argv[++i] || "";
  }
  a.url = a.url || process.env.MELLOW_LOG_URL || "";
  a.token = a.token || process.env.MELLOW_LOG_TOKEN || "";
  return a;
}

// ---- 正規化（public/chat-widget.js の normalize と同じ規則）---------
// 表記ゆれ（全半角・カナ/ひらがな・記号・丁寧語尾）を吸収して同一質問を束ねる。
function normalize(str) {
  if (!str) return "";
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/ー/g, "")
    .replace(/[\s　、。・,.?？!！「」『』（）()~〜・:：;；]/g, "")
    .replace(/でしょうか|ですか|でしょう|ください|のですが|んですが|たいです|ほうがいい|ますか|ません|ですが|します|です|ます|たい|かな|かしら|って/g, "");
}

function bigrams(s) {
  const arr = [];
  if (s.length <= 1) { if (s) arr.push(s); return arr; }
  for (let i = 0; i < s.length - 1; i++) arr.push(s.substr(i, 2));
  return arr;
}

function diceSimilarity(aGrams, bGrams) {
  if (!aGrams.length || !bGrams.length) return 0;
  const map = new Map();
  for (const g of aGrams) map.set(g, (map.get(g) || 0) + 1);
  let inter = 0;
  for (const g of bGrams) {
    const n = map.get(g) || 0;
    if (n > 0) { inter++; map.set(g, n - 1); }
  }
  return (2 * inter) / (aGrams.length + bGrams.length);
}

// ---- ログ取得 ------------------------------------------------------
async function fetchLog(a) {
  const u = new URL(a.url);
  u.searchParams.set("action", "export");
  u.searchParams.set("learn", "1");                 // 育成対象だけ（fallback/suggested/unresolved/未回答）
  u.searchParams.set("days", a.all ? "0" : String(a.days));
  if (a.token) u.searchParams.set("token", a.token);

  const res = await fetch(u, { redirect: "follow", headers: { "User-Agent": "mellow-harvest/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}（エクスポートURL・公開設定を確認）`);
  const data = await res.json();
  if (!data || data.ok === false) throw new Error(`エクスポート拒否: ${data && data.error}（tokenを確認）`);
  return Array.isArray(data.rows) ? data.rows : [];
}

// ---- クラスタリング -------------------------------------------------
// まず正規化キーが完全一致するものを束ね、次に似たクラスタ同士を貪欲にマージする。
function cluster(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const q = String(r.question || "").trim();
    if (!q) continue;
    const key = normalize(q);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { norm: key, grams: bigrams(key), variants: new Map(), outcomes: {}, count: 0, lastDate: "" });
    }
    const cl = byKey.get(key);
    cl.count++;
    cl.variants.set(q, (cl.variants.get(q) || 0) + 1);
    const oc = String(r.outcome || (r.hit ? "answered" : "fallback"));
    cl.outcomes[oc] = (cl.outcomes[oc] || 0) + 1;
    if (String(r.date || "") > cl.lastDate) cl.lastDate = String(r.date || "");
  }

  // 似たクラスタを貪欲マージ（件数の多い方へ吸収）
  const list = [...byKey.values()].sort((x, y) => y.count - x.count);
  const merged = [];
  for (const cl of list) {
    let target = null;
    for (const m of merged) {
      if (diceSimilarity(m.grams, cl.grams) >= SIM_THRESHOLD) { target = m; break; }
    }
    if (target) {
      target.count += cl.count;
      for (const [q, n] of cl.variants) target.variants.set(q, (target.variants.get(q) || 0) + n);
      for (const k in cl.outcomes) target.outcomes[k] = (target.outcomes[k] || 0) + cl.outcomes[k];
      if (cl.lastDate > target.lastDate) target.lastDate = cl.lastDate;
    } else {
      merged.push(cl);
    }
  }

  // 出力形に整形（代表質問＝そのクラスタで最頻の原文）
  return merged
    .map((m) => {
      const variants = [...m.variants.entries()]
        .map(([question, count]) => ({ question, count }))
        .sort((a, b) => b.count - a.count);
      return {
        representative: variants[0].question,
        normalized: m.norm,
        count: m.count,
        outcomes: m.outcomes,
        lastDate: m.lastDate,
        variants,
      };
    })
    .sort((a, b) => b.count - a.count);
}

// ---- メイン --------------------------------------------------------
async function main() {
  const a = parseArgs(process.argv);
  if (!a.url) {
    console.error(
      "エクスポートURLが未指定です。GAS（gas/Code.gs）をウェブアプリとしてデプロイし、\n" +
      "そのURLを MELLOW_LOG_URL 環境変数か --url で渡してください。\n" +
      '例: MELLOW_LOG_URL="https://script.google.com/macros/s/XXX/exec" node tools/harvest-questions.mjs'
    );
    process.exit(1);
  }

  console.log(`ログ取得中… (${a.all ? "全期間" : "直近" + a.days + "日"})`);
  const rows = await fetchLog(a);
  console.log(`育成対象の質問: ${rows.length}件`);

  const clusters = cluster(rows);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: a.url.replace(/\?.*$/, ""),
    window: a.all ? "all" : `${a.days}d`,
    totalRows: rows.length,
    clusterCount: clusters.length,
    clusters,
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");

  console.log(`\n完了: ${clusters.length}クラスタを ${OUT} に保存しました。`);
  if (clusters.length) {
    console.log("\n■ 件数の多い未回答クラスタ（上位10）:");
    for (const c of clusters.slice(0, 10)) {
      const oc = Object.entries(c.outcomes).map(([k, v]) => `${k}:${v}`).join(" ");
      console.log(`  ${String(c.count).padStart(3)}件  ${c.representative}   [${oc}]`);
    }
  }
  console.log("\n次の手順: tools/grow-faq-prompt.md の指示文と unanswered.json を Claude に渡し、faq.json 更新案を作成 → 人が確認 → FTP反映。");
}

main().catch((e) => {
  console.error("収集失敗:", e.message || e);
  process.exit(1);
});
