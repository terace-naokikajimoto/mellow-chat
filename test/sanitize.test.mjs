// 回答HTMLのサニタイズ検証
// 実行: node test/sanitize.test.mjs
// ------------------------------------------------------------------
// faq.json は「プログラミング不要で編集できる」運用にしているため、
// 編集ミス・コピペ・配信元の乗っ取りで危険なタグが混ざる可能性が常にある。
// その状態でも本体サイト上でスクリプトが動かないことを機械的に担保する。
//
// サニタイズはブラウザのHTMLパーサの挙動そのものが要点（`<img src=x
// onerror=…>` の属性解釈や `java\tscript:` のような細工は実装ごとに差が出る）。
// そのため jsdom で近似せず、実際の Chrome で検証する。依存パッケージは
// 増やさない方針なので、OS の Chrome を headless で起動して使う。
// 判定は1回の評価でまとめて行う（往復を増やすと遅く、途中で切れやすい）。
// ------------------------------------------------------------------
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9422);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const widgetSrc = readFileSync(new URL("../public/chat-widget.js", import.meta.url), "utf8");
const faqRaw = readFileSync(new URL("../public/faq.json", import.meta.url), "utf8");

// プロファイルは毎回作って必ず消す（残すとディスクを食い潰す）
const profile = mkdtempSync(join(tmpdir(), "mellow-sanitize-"));
const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-first-run", "--disable-extensions",
  "--no-default-browser-check", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
], { stdio: "ignore" });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (e) => { console.error(e.message); cleanup(); process.exit(1); });

async function openTab() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error("headless Chrome に接続できません（CHROME_PATH で場所を指定できます）");
}

const tab = await openTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
// readyState を見ないと「assignする前に開いていた」場合に永久に待ってしまう
if (ws.readyState !== 1) await new Promise((r) => { ws.onopen = r; });

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(method + " が応答しません")); }, 30000);
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error("ブラウザ側でエラー: " + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  }
  return r.result?.result?.value;
}

// window.module を先に置くと、ウィジェットは「テスト用の書き出し」経路を通り、
// UIを組まずに内部関数だけを返す（本番の動作には影響しない分岐）。
await evaluate("window.module = { exports: {} };");
await evaluate(widgetSrc);

const results = await evaluate(`(function () {
  var W = window.module.exports;
  var faq = ${faqRaw};
  var H = function (s) { return W.sanitizeHtml(s).innerHTML; };
  var out = [];
  function check(name, ok, detail) { out.push({ name: name, ok: !!ok, detail: detail || "" }); }

  // ① 危険なものが残らないこと
  [
    ["<script>alert(1)</script>", "script"],
    ["<img src=x onerror=alert(1)>", "onerror"],
    ["<img src=x onerror=alert(1)>", "<img"],
    ['<a href="javascript:alert(1)">x</a>', "javascript:"],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', "javascript:"],
    ['<a href="java\\tscript:alert(1)">x</a>', "script:"],
    ['<a href="  javascript:alert(1)">x</a>', "javascript:"],
    ['<a href="java script:alert(1)">x</a>', "script:"],
    ['<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', "data:"],
    ["<iframe src=//evil.example></iframe>", "iframe"],
    ["<svg onload=alert(1)></svg>", "onload"],
    ["<object data=x></object>", "object"],
    ["<style>body{display:none}</style>", "display:none"],
    ["<script>alert(1)</script>", "alert"],
    ["<noscript>隠し</noscript>", "隠し"],
    ['<div onclick="alert(1)">x</div>', "onclick"],
    ['<strong style="position:fixed;inset:0">x</strong>', "style"],
    ['<form action="//evil.example"><input name=a></form>', "<form"],
    ['<a href="vbscript:msgbox(1)">x</a>', "vbscript:"],
    ['<a href="#" onmouseover="alert(1)">x</a>', "onmouseover"],
    ['<a href="https://x.test" target="_blank" onfocus="alert(1)">x</a>', "onfocus"]
  ].forEach(function (c) {
    var r = String(H(c[0])).toLowerCase();
    check("除去: " + c[1] + "  ← " + c[0].slice(0, 40), r.indexOf(c[1].toLowerCase()) === -1, H(c[0]));
  });

  // ② 通すべき装飾・リンクを壊していないこと（消しすぎると回答が読めない）
  [
    ["<strong>太字</strong>", "<strong>太字</strong>"],
    ["改行<br>あり", "<br>"],
    ['<a href="https://mellow-wet.jp/contact.html" target="_blank" rel="noopener">問い合わせ</a>',
     'href="https://mellow-wet.jp/contact.html"'],
    ["<ul><li>項目</li></ul>", "<li>項目</li>"]
  ].forEach(function (c) {
    var r = String(H(c[0]));
    check("保持: " + c[0].slice(0, 40), r.indexOf(c[1]) !== -1, r);
  });

  // ③ 許可していないドメインへのリンクは無効化される
  //    （faq.json が書き換えられた時の偽サイト誘導を防げているか）
  [
    ['<a href="https://evil.example/phish">お得情報</a>', "evil.example"],
    ['<a href="https://evilmellow-wet.jp/x">偽</a>', "evilmellow-wet.jp"],
    ['<a href="//evil.example/x">偽</a>', "evil.example"],
    ['<a href="https://mellow-wet.jp.evil.example/x">偽</a>', "evil.example"]
  ].forEach(function (c) {
    var r = String(H(c[0]));
    check("許可外リンクを無効化: " + c[1], r.indexOf("href") === -1, r);
  });
  // 正規の掲載先とサイト内リンクは残る
  [
    ['<a href="https://mellow-wet.jp/shop.html">店舗</a>', "mellow-wet.jp/shop.html"],
    ['<a href="https://www.rakuten.co.jp/plyflex/">楽天</a>', "rakuten.co.jp"],
    ['<a href="/order.html">注文</a>', "/order.html"],
    ['<a href="mailto:info@example.com">mail</a>', "mailto:"]
  ].forEach(function (c) {
    var r = String(H(c[0]));
    check("正規リンクは保持: " + c[1], r.indexOf(c[1]) !== -1, r);
  });

  // ④ target=_blank には noopener を必ず付ける（付け忘れの自動補正）
  var blank = String(H('<a href="https://mellow-wet.jp/x" target="_blank">x</a>'));
  check("target=_blank に noopener を自動付与", blank.indexOf("noopener") !== -1, blank);

  // ⑤ 実運用の faq.json 全件で、リンクが失われていないこと
  var lost = [];
  faq.faqs.forEach(function (f) {
    var before = (f.answer.match(/<a\\b/g) || []).length;
    if (!before) return;
    var after = (String(H(f.answer)).match(/<a\\b/g) || []).length;
    if (before !== after) lost.push(f.q);
  });
  check("faq.json 全" + faq.faqs.length + "問のリンクが保持されている", lost.length === 0, lost.join(" / "));

  // ⑥ あいさつ文・フォールバック文も同じ経路を通るので一緒に見る
  [["greeting", faq.greeting], ["fallback", faq.fallback]].forEach(function (kv) {
    var r = String(H(kv[1])).toLowerCase();
    check(kv[0] + " に危険なタグが無い",
      r.indexOf("<script") === -1 && r.indexOf("javascript:") === -1 && r.indexOf(" on") === -1, r);
  });

  return out;
})()`);

let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  if (!r.ok) console.log(`     結果: ${String(r.detail).slice(0, 200)}`);
}
console.log(`\n結果: ${pass}/${results.length} 通過`);

ws.close();
cleanup();
process.exit(pass === results.length ? 0 : 1);
