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
    var question = String(data.question || "").slice(0, MAX_QUESTION_LEN);

    var sheet = getSheet_();
    var now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");

    sheet.appendRow([
      now,
      question,
      data.hit ? "○" : "×（未回答）",
      data.matched || "",
      data.source === "preset" ? "ボタン" : (data.source === "feedback" ? "評価" : "自由入力"),
      page,
      data.ua || "",
      data.outcome || ""
    ]);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
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
  // 書き込みと同じ共有トークンで保護（漏えい時の閲覧を防ぐ）
  if (SHARED_TOKEN && String(p.token || "") !== SHARED_TOKEN) {
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
    var date = String(v[iDate] || "");
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
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
