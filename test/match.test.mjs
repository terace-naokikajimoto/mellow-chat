// 意図推定マッチングの動作確認（APIなし）
// 実行: node test/match.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ブラウザ前提のグローバルを最小限スタブ（IIFE冒頭の window 参照対策）
globalThis.window = {};

const widget = require("../public/chat-widget.js");
const faq = JSON.parse(readFileSync(new URL("../public/faq.json", import.meta.url)));
widget._setData(faq);

// 「キーワードそのものではない言い回し」で意図が汲めるかを検証
const cases = [
  ["このウェットスーツって高いの？", "料金・価格はいくらですか？"],
  ["どのくらいで届きますか", "納期はどれくらいかかりますか？"],
  ["カードで払える？", "支払い方法は何がありますか？"],
  ["寒い時期でも暖かいやつある？", null], // セミドライ/起毛/季節 いずれか近いものが出ればOK
  ["自分で測っても大丈夫かな", "自宅採寸でも本当に体に合いますか？"],
  ["何を買えばいいか全然わからない", "初心者です。何を選べばいいですか？"],
  ["近くにお店ある？試着したい", "店舗はどこ？試着できますか？"],
  ["洗ったほうがいいですか", "お手入れ・洗い方を教えてください"],
  ["何年くらい使える？", "ウェットスーツの寿命は何年くらい？"],
  ["地方からでも頼める？", "遠方ですが注文できますか？（通販）"],
  ["バックジップとチェストジップどっちがいい", "ファスナー（バックジップ/チェストジップ）の違いは？"],
  ["子ども用ありますか", "レディースやキッズのサイズはありますか？"],
  ["返品できる？", "返品・交換はできますか？"],
  ["asdfqwer", null] // 無関係 → フォールバックされるべき
];

let pass = 0, total = cases.length;
for (const [q, expected] of cases) {
  const ranked = widget.rankAnswers(q);
  const top = ranked[0];
  const score = top ? top.score.toFixed(1) : "-";
  const tier =
    top && top.score >= widget.CONFIDENT_SCORE ? "回答" :
    top && top.score >= widget.SUGGEST_SCORE ? "候補提示" : "フォールバック";
  const topQ = top ? top.item.q : "(なし)";

  let ok;
  if (expected === null) {
    // 無関係クエリ：フォールバックになればOK / それ以外は最有力が妥当ならOK
    ok = q === "asdfqwer" ? tier === "フォールバック" : (tier !== "フォールバック");
  } else {
    // 期待FAQが「即回答」か「候補提示の上位」に入っていれば成功
    const inTop3 = ranked.slice(0, 3).some(r => r.item.q === expected);
    ok = tier !== "フォールバック" && inTop3;
  }
  if (ok) pass++;
  console.log(
    `${ok ? "✅" : "❌"} [${tier} ${score}] "${q}"\n     → ${topQ}`
  );
}
console.log(`\n結果: ${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);
