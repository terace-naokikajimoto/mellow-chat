// 回答精度の測定（APIなし）
// 実行: node test/eval.mjs            … 集計だけ
//       node test/eval.mjs --miss     … 外したものを一覧
//       node test/eval.mjs --grid     … しきい値・重みを振って比べる
//
// test/eval-set.json は「訪問者が打ちそうな質問」と「答えるべきFAQ（q）」の組。
// FAQを書いた人とは別に作った質問なので、faq.json の examples に寄せた
// 言い回しだけで点が取れることはない（＝本番の質問に近い採点になる）。
//   expect: 答えるべきFAQの q。null は「FAQに答えが無い／対象外」
//   also:   これでも正解とみなすFAQの q（任意）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.window = {};
const widget = require("../public/chat-widget.js");
const faq = JSON.parse(readFileSync(new URL("../public/faq.json", import.meta.url)));
const fullSet = JSON.parse(readFileSync(new URL("./eval-set.json", import.meta.url)));
// 重みを決める半分（偶数番）と、決めた重みが通用するか確かめる半分（奇数番）に分ける。
// 同じ問題で調整して同じ問題で採点すると、その300問にだけ強い設定を選んでしまうため。
const half = (k) => fullSet.filter((_, i) => i % 2 === k);
let set = process.argv.includes("--tune") ? half(0) : process.argv.includes("--holdout") ? half(1) : fullSet;
widget._setData(faq);

const known = new Set(faq.faqs.map((f) => f.q));
for (const c of set) {
  for (const q of [c.expect, ...(c.also || [])]) {
    if (q != null && !known.has(q)) console.warn(`⚠ eval-set の expect が faq.json に無い: ${q}`);
  }
}

// chat-widget.js の handleUserMessage と同じ出し分け
function decide(text) {
  if (widget.smallTalk(text)) return { tier: "smalltalk", items: [] };
  const t = widget._thresholds();
  const ranked = widget.rankAnswers(text);
  const top = ranked[0];
  if (!top || top.score < t.SUGGEST_SCORE) return { tier: "fallback", items: [] };
  if (top.score >= t.CONFIDENT_SCORE) {
    const near = ranked.filter((r) => r.score >= top.score * t.AMBIGUOUS_RATIO).slice(0, 3);
    if (near.length >= 2) return { tier: "ambiguous", items: near.map((r) => r.item.q) };
    return { tier: "answered", items: [top.item.q] };
  }
  return { tier: "suggested", items: ranked.filter((r) => r.score >= t.SUGGEST_SCORE).slice(0, 3).map((r) => r.item.q) };
}

function run(verbose) {
  const n = { right: 0, offeredRight: 0, wrong: 0, offeredWrong: 0, missed: 0, oosOk: 0, oosAnswered: 0, oosOffered: 0 };
  const misses = [];
  let inScope = 0, oos = 0;
  for (const c of set) {
    const d = decide(c.q);
    if (c.expect == null) {
      oos++;
      if (d.tier === "answered") { n.oosAnswered++; misses.push(["対象外に回答", c, d]); }
      else if (d.tier === "fallback" || d.tier === "smalltalk") n.oosOk++;
      else n.oosOffered++;
      continue;
    }
    inScope++;
    const ok = new Set([c.expect, ...(c.also || [])]);
    if (d.tier === "answered") {
      if (ok.has(d.items[0])) n.right++;
      else { n.wrong++; misses.push(["誤答", c, d]); }
    } else if (d.tier === "ambiguous" || d.tier === "suggested") {
      if (d.items.some((q) => ok.has(q))) n.offeredRight++;
      else { n.offeredWrong++; misses.push(["候補に無い", c, d]); }
    } else { n.missed++; misses.push(["答えられず", c, d]); }
  }
  const pct = (x, d) => `${((100 * x) / (d || 1)).toFixed(1)}%`;
  if (verbose !== "quiet") {
    console.log(`答えがある質問 ${inScope}件`);
    console.log(`  即回答で正解       ${n.right}（${pct(n.right, inScope)}）`);
    console.log(`  候補に正解を出せた ${n.offeredRight}（${pct(n.offeredRight, inScope)}）`);
    console.log(`  即回答で誤答       ${n.wrong}（${pct(n.wrong, inScope)}）← いちばん避けたい`);
    console.log(`  候補に正解が無い   ${n.offeredWrong}（${pct(n.offeredWrong, inScope)}）`);
    console.log(`  答えられず         ${n.missed}（${pct(n.missed, inScope)}）`);
    console.log(`答えが無い／対象外 ${oos}件`);
    console.log(`  正しく見送り       ${n.oosOk}（${pct(n.oosOk, oos)}）`);
    console.log(`  候補を出した       ${n.oosOffered}`);
    console.log(`  誤って回答         ${n.oosAnswered}`);
  }
  if (verbose === "miss") {
    for (const [kind, c, d] of misses) {
      console.log(`\n[${kind}] ${c.q}\n   正解: ${c.expect ?? "(対象外)"}\n   出力: ${d.tier} → ${d.items.join(" / ") || "-"}`);
    }
  }
  return { n, inScope, oos };
}

const arg = process.argv.find((a) => a === "--grid" || a === "--miss");
if (arg === "--grid") {
  set = half(0);
  const rows = [];
  for (const EXAMPLE_WEIGHT of [12, 16, 20])
    for (const DICE_WEIGHT of [0, 4, 8])
      for (const CONFIDENT_SCORE of [10, 12, 14, 16, 18, 20])
        for (const SUGGEST_SCORE of [2.5, 4, 6])
          for (const AMBIGUOUS_RATIO of [0.9, 0.94, 0.97]) {
            widget._tune({ EXAMPLE_WEIGHT, DICE_WEIGHT, CONFIDENT_SCORE, SUGGEST_SCORE, AMBIGUOUS_RATIO });
            const { n } = run("quiet");
            // 誤答は「答えられず」の3倍悪いとみなす（間違った案内は信用を失う）
            const util = n.right + 0.6 * n.offeredRight - 3 * (n.wrong + n.oosAnswered) - 0.5 * (n.offeredWrong + n.oosOffered);
            rows.push({ EXAMPLE_WEIGHT, DICE_WEIGHT, CONFIDENT_SCORE, SUGGEST_SCORE, AMBIGUOUS_RATIO, right: n.right, offered: n.offeredRight, wrong: n.wrong, oosAns: n.oosAnswered, util: +util.toFixed(1) });
          }
  rows.sort((a, b) => b.util - a.util);
  console.log("調整用の半分で上位:");
  console.table(rows.slice(0, 10));
  const { util, right, offered, wrong, oosAns, ...best } = rows[0];
  widget._tune(best);
  set = half(1);
  console.log("\n上位1位の設定を、調整に使っていない半分で採点:", best);
  run("summary");
} else {
  run(arg === "--miss" ? "miss" : "summary");
}
