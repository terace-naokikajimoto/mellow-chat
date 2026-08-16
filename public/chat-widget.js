/*!
 * mellow-wet.jp FAQ チャットウィジェット
 * ------------------------------------------------------------------
 * 使い方: 本体サイトの </body> 直前に次の1行を追加するだけ。
 *   <script src="https://chat.mellow-wet.jp/chat-widget.js" defer></script>
 *
 * 回答内容の編集は同じフォルダの faq.json を書き換えるだけ（このJSは触らなくてOK）。
 *
 * 仕組み: ルールベース＋意図推定。サーバー処理・APIキー不要。
 *   起動時に faq.json を読み込み、キーワード一致／意図グループ／文字N-gram類似度を
 *   組み合わせて入力の“意図”を汲み取り、最も近い回答を返す。断定できない時は
 *   近い質問の候補を提示して、用意した回答へ誘導する。
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  // 二重読み込みガード（同じページに2回貼られても1つだけ動く）
  if (window.__mellowChatLoaded) return;
  window.__mellowChatLoaded = true;

  // ============================================================
  // CONFIG : 見た目や挙動の調整はここだけ変えればOK
  // ============================================================
  var CONFIG = {
    title: "メロー チャットサポート",      // パネル上部のタイトル
    subtitle: "ウェットスーツのご質問にお答えします",
    launcherLabel: "質問する",            // 吹き出しボタンの文字（空にするとアイコンのみ）
    accent: "#0d6e8c",                     // メインカラー（サイトのトーンに合わせて変更可）
    accentText: "#ffffff",                 // メインカラー上の文字色
    // 何を書けばいいか分からず手が止まるのを防ぐため、具体例をそのまま置く
    placeholder: "例：納期はどれくらい？",
    // faq.json の場所。通常はこのJSと同じフォルダなので相対パスでOK。
    // 別の場所に置く場合だけ絶対URLに変更（例: "https://chat.mellow-wet.jp/faq.json"）
    dataUrl: "faq.json",
    maxPresets: 6,                         // 「よくある質問」ボタンの表示数
    // 開いた直後に出す「すぐ押せる質問」の数。カテゴリ名だけ並べても
    // “何が聞けるのか”が伝わらず手が止まるので、具体的な質問を先に見せる。
    // faq.json で "popular": true を付けた項目が優先される。
    quickPicks: 4,
    // 答えにたどり着けなかった人の逃げ道。選択肢の末尾に常設する。
    contactUrl: "https://mellow-wet.jp/contact.html",
    contactLabel: "✉️ スタッフに直接きく",

    // ▼ 質問のログ蓄積（Googleスプレッドシート）
    // Google Apps Script を「ウェブアプリ」としてデプロイして得たURLをここに貼ると、
    // 訪問者の質問が自動でスプレッドシートに記録されていきます（設定手順は README / gas/Code.gs 参照）。
    // 空のままなら記録機能はオフ（ウィジェットは通常どおり動きます）。
    logUrl: "https://script.google.com/macros/s/AKfycbwGHWuMhNzJI5hquIbXXVNeO_XpR5yf1JX9UAzCJbk01jfZKU_BYpN52gzVGL7_jMcbqQ/exec",
    // スパム対策の共有トークン。gas/Code.gs の SHARED_TOKEN と同じ文字列を入れると、
    // そのトークンを持つ送信だけがシートに記録されます（空なら検証なし）。
    // ※公開JS内なので完全な秘匿ではありませんが、無差別スパムの大半は防げます。
    logToken: "a84625f7acfb218fd18482c16cf67ee4",
    // プリセットボタン経由の質問も記録するか（false=自由入力のみ記録）
    logPresetClicks: true
  };

  // ============================================================
  // データ読み込み
  // ============================================================
  // dataUrl をこのスクリプト自身の場所基準で解決（埋め込み先のページ位置に左右されない）
  function resolveDataUrl() {
    if (/^https?:\/\//.test(CONFIG.dataUrl) || CONFIG.dataUrl.charAt(0) === "/") {
      return CONFIG.dataUrl;
    }
    try {
      var me = document.currentScript || (function () {
        var s = document.getElementsByTagName("script");
        return s[s.length - 1];
      })();
      if (me && me.src) {
        return me.src.replace(/[^/]*$/, "") + CONFIG.dataUrl;
      }
    } catch (e) { /* fallthrough */ }
    return CONFIG.dataUrl;
  }

  var DATA = { faqs: [], categories: [], fallback: "", greeting: "" };

  // ============================================================
  // マッチングロジック
  // ------------------------------------------------------------
  // 「キーワードが文字列として含まれるか」だけだと、言い換え・表記ゆれ・
  // 語順違いに弱く“答えられない”が増える。そこでAPIを使わずに
  // 「意図を汲む」ため、次の3つの手がかりを組み合わせてスコア化する:
  //   ① 意図グループ辞書 … 同じ意図の言い回し（値段/高い/安い…）を束ねる
  //   ② N-gram類似度(Dice) … 部分一致・語順違い・表記ゆれを吸収
  //   ③ キーワード一致 … 従来どおりの強い手がかり
  // さらに確信度に応じて「即回答 / もしかして候補提示 / カテゴリ誘導」を
  // 出し分け、用意した回答になるべくたどり着けるようにする。
  // ============================================================

  // しきい値（スコアの目安。下げるほど積極的に回答する）
  var CONFIDENT_SCORE = 5;    // これ以上なら自信を持って即回答
  var SUGGEST_SCORE   = 1.0;  // これ以上なら「もしかして」候補として提示
  var AMBIGUOUS_RATIO = 0.92; // 上位がこの比率以上で僅差なら「どれ？」と選んでもらう

  // 意図グループ：同じ意図を表す言い回しの集合。
  // 入力とFAQの双方が同じグループの語を含めば「意図が一致」とみなして加点する。
  // → キーワードに無い言い換え（例「高い？」）でも価格FAQにたどり着ける。
  // ※活用形のゆれ（洗う/洗った/洗いたい…）に強くするため、動詞は漢字一字の
  //   語幹（洗・測・届…）も入れている。漢字語幹はこの分野では誤検出が少ない。
  var INTENT_GROUPS = [
    // 価格・コスト
    ["値段", "価格", "料金", "いくら", "高い", "高め", "安い", "やすい", "お得", "おとく", "コスパ", "コストパフォーマンス", "予算", "費用", "金額", "相場", "お金", "円", "万円", "ねだん"],
    // 納期・スピード
    ["納期", "いつ", "届", "とどく", "どのくらい", "どれくらい", "期間", "間に合", "まにあ", "日数", "何日", "待", "発送", "完成", "出来上が", "急ぎ", "すぐ"],
    // 支払い
    ["支払", "決済", "クレジット", "カード", "代引", "代金引換", "振込", "銀行", "後払", "分割", "送料", "払"],
    // サイズ・採寸・フィット
    ["採寸", "サイズ", "測", "計測", "寸法", "フィット", "合う", "あう", "ぴったり", "きつい", "ゆるい", "大き", "小さ", "体型"],
    // 選び方・おすすめ
    ["おすすめ", "オススメ", "どれ", "どっち", "どちら", "選", "迷", "わからな", "分からな", "わかんな", "初心者", "はじめて", "初めて", "何を", "比較", "違い", "ちがい"],
    // 暖かさ・季節
    ["暖か", "あたたか", "温か", "寒", "さむ", "保温", "冬", "夏", "春", "秋", "季節", "水温", "気温", "防寒", "起毛"],
    // 注文の流れ
    ["注文", "オーダー", "頼", "申し込", "申込", "流れ", "手順", "やり方", "方法", "ステップ", "買", "購入"],
    // 手入れ・保管・寿命
    ["お手入れ", "手入れ", "洗", "洗濯", "保管", "しまい方", "しまう", "干", "ケア", "メンテ", "寿命", "長持ち", "におい", "臭"],
    // 修理・保証
    ["修理", "リペア", "直", "破れ", "破る", "穴", "ほつれ", "補修", "保証", "アフター", "不具合", "故障"],
    // 店舗・来店
    ["店舗", "お店", "場所", "住所", "どこ", "アクセス", "来店", "試着", "営業時間", "電話", "予約", "近く"],
    // 通販・遠方
    ["通販", "遠方", "地方", "オンライン", "郵送", "全国", "ネット", "来店できない", "近くにない", "行けない"],
    // 返品・キャンセル
    ["返品", "交換", "キャンセル", "返金", "やめたい"],
    // 対象者・用途
    ["レディース", "女性", "メンズ", "男性", "キッズ", "子供", "子ども", "ジュニア", "ダイビング", "シュノーケル", "スキューバ"],
    // 仕様・オプション
    ["ファスナー", "ジップ", "ジッパー", "オプション", "仕様", "カラー", "色", "デザイン", "名前", "ロゴ", "刺繍", "ネーム", "ワッペン"],
    // 配送・送料
    ["送料", "配送", "発送", "宅配", "手数料", "無料", "ヤマト", "佐川", "着払", "運賃"],
    // 産地・品質
    ["日本製", "国産", "国内生産", "made", "工場", "生産", "産地", "品質", "中国製", "海外製", "職人", "縫製"],
    // 法人・OEM・フランチャイズ
    ["フランチャイズ", "代理店", "取扱店", "パートナー", "加盟", "oem", "別注", "チーム", "法人", "卸", "販売店", "独立", "開業", "お揃い", "おそろ", "オリジナル"],
    // 海外
    ["海外", "輸出", "overseas", "国際", "アメリカ", "ハワイ", "台湾", "韓国", "外国"],
    // リピート・過去データ
    ["リピート", "リピーター", "2着目", "二着目", "前回", "以前", "買い替え", "再注文", "常連"],
    // 小物・アクセサリー
    ["タオル", "ポンチョ", "デッキパッド", "小物", "グッズ", "インナー", "ブーツ", "グローブ", "キャップ", "着替え"],
    // 地域（お住まいのエリアで装備が変わるため）
    ["北海道", "青森", "岩手", "宮城", "仙台", "福島", "茨城", "千葉", "湘南", "伊豆", "静岡", "伊良湖", "伊勢", "和歌山", "四国", "徳島", "高知", "宮崎", "九州", "沖縄", "地域", "エリア", "地元", "住んで"]
  ];

  function normalize(str) {
    if (!str) return "";
    return String(str)
      .trim()
      .toLowerCase()
      // 全角英数字 → 半角
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      })
      // カタカナ → ひらがな（「サーフィン/さーふぃん」を同一視）
      .replace(/[ァ-ヶ]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0x60);
      })
      // 長音・小書きなどの細かなゆれを吸収
      .replace(/ー/g, "")
      // 記号・空白をまとめて除去（ゆらぎ吸収）
      .replace(/[\s　、。・,.?？!！「」『』（）()~〜・:：;；]/g, "")
      // 丁寧表現・終助詞など“意味の薄い語尾”を除去。
      // これらが残ると、長い回答文との bi-gram 重なり（ノイズ）で
      // 無関係な項目が上位に来てしまうため、類似度の精度が上がる。
      .replace(/でしょうか|ですか|でしょう|ください|のですが|んですが|たいです|ほうがいい|ますか|ません|ですが|します|です|ます|たい|かな|かしら|って/g, "");
  }

  // HTMLタグを除いた素のテキスト（回答本文も検索対象にするため）
  function stripHtml(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ");
  }

  // 文字bi-gram集合を作る（1文字語はそのまま1要素に）
  function bigrams(s) {
    var arr = [];
    if (s.length <= 1) { if (s) arr.push(s); return arr; }
    for (var i = 0; i < s.length - 1; i++) arr.push(s.substr(i, 2));
    return arr;
  }

  // Dice係数（0〜1）。2つの文字列のbi-gram重なり具合 = 表記ゆれに強い類似度。
  function diceSimilarity(aGrams, bGrams) {
    if (!aGrams.length || !bGrams.length) return 0;
    var map = {}, i, g, inter = 0;
    for (i = 0; i < aGrams.length; i++) { g = aGrams[i]; map[g] = (map[g] || 0) + 1; }
    for (i = 0; i < bGrams.length; i++) {
      g = bGrams[i];
      if (map[g] > 0) { inter++; map[g]--; }
    }
    return (2 * inter) / (aGrams.length + bGrams.length);
  }

  // 起動時に各FAQの検索用インデックスを前計算（毎回の検索を軽く＆正確に）
  function buildIndex() {
    for (var i = 0; i < DATA.faqs.length; i++) {
      var f = DATA.faqs[i];
      var kws = (f.keywords || []).map(normalize);
      f._kw = kws;                                   // 正規化済みキーワード
      f._qn = normalize(f.q);                         // 正規化済み質問文
      // 高信号フィールド（質問文＋キーワード）。この項目が“何についてか”を表す。
      f._signal = f._qn + kws.join("");
      // 回答本文も含めた“干し草の山”（類似度・recall用）
      var hay = f._signal + normalize(stripHtml(f.answer));
      f._grams = bigrams(hay);                        // 類似度計算用bi-gram
      // この項目が属する意図グループ番号の集合（本文も含めて広めに判定＝recall）
      f._intents = {};
      for (var g = 0; g < INTENT_GROUPS.length; g++) {
        for (var t = 0; t < INTENT_GROUPS[g].length; t++) {
          if (hay.indexOf(normalize(INTENT_GROUPS[g][t])) !== -1) { f._intents[g] = true; break; }
        }
      }
    }
  }

  // 入力に含まれる意図グループ番号と、実際にヒットした意図語を返す
  function queryIntents(q) {
    var groups = {}, terms = [];
    for (var g = 0; g < INTENT_GROUPS.length; g++) {
      for (var t = 0; t < INTENT_GROUPS[g].length; t++) {
        var nt = normalize(INTENT_GROUPS[g][t]);
        if (nt && q.indexOf(nt) !== -1) { groups[g] = true; terms.push(nt); }
      }
    }
    return { groups: groups, terms: terms };
  }

  // 入力文を全FAQと照合し、スコアの高い順に並べて返す
  function rankAnswers(input) {
    var q = normalize(input);
    if (!q) return [];
    var qGrams = bigrams(q);
    var qi = queryIntents(q);

    var ranked = [];
    for (var i = 0; i < DATA.faqs.length; i++) {
      var item = DATA.faqs[i];
      var score = 0;
      var kws = item._kw || [];

      // ① キーワード一致（最も強い手がかり）。長い＝具体的な語ほど加点。
      // ただし1文字のキーワード（"s" "m" など）は無関係な入力にも当たってしまい、
      // それ1つで確信しきい値を超えるとフォールバックすべき質問に誤答する。
      // 弱い手がかり扱いにして、単独では即答させない。
      for (var k = 0; k < kws.length; k++) {
        var kw = kws[k];
        if (!kw || q.indexOf(kw) === -1) continue;
        score += kw.length >= 2 ? 5 + kw.length * 0.4 : 1.5;
      }

      // ② 質問文そのものとの部分一致
      if (item._qn && (q.indexOf(item._qn) !== -1 || item._qn.indexOf(q) !== -1)) score += 3;

      // ③ 意図語の精密一致：入力に出た意図語が、この項目の“高信号フィールド”
      //    （質問文＋キーワード）に直接含まれる＝まさにその話題、と判断して強く加点。
      //    「洗った」→意図語「洗」がお手入れFAQのキーワードにある、のように
      //    活用形・言い換えをキーワードに橋渡しする。
      for (var p = 0; p < qi.terms.length; p++) {
        if (item._signal.indexOf(qi.terms[p]) !== -1) { score += 4; break; }
      }

      // ④ 意図グループの一致（本文も含めた緩い共有＝取りこぼし防止のrecall）
      for (var gid in qi.groups) {
        if (item._intents && item._intents[gid]) score += 1.2;
      }

      // ⑤ N-gram類似度（表記ゆれ・語順違い・部分一致を拾う）
      score += diceSimilarity(qGrams, item._grams || []) * 8;

      // 同点なら keywords が少ない＝より具体的な項目を優先（わずかな補正）
      var tieBreak = kws.length ? 1 / kws.length : 0;
      score += tieBreak * 0.001;

      if (score > 0) ranked.push({ item: item, score: score });
    }

    ranked.sort(function (a, b) { return b.score - a.score; });
    return ranked;
  }

  // 後方互換：最有力のFAQを返す（ログ判定などで使用）。確信なしなら null。
  function findAnswer(input) {
    var r = rankAnswers(input);
    return (r.length && r[0].score >= CONFIDENT_SCORE) ? r[0].item : null;
  }

  // ============================================================
  // UI構築（Shadow DOM で本体サイトのCSSと完全分離）
  // ============================================================
  var ui = {}; // 主要な要素を保持

  function buildUI() {
    var host = document.createElement("div");
    host.id = "mellow-chat-widget";
    var shadow = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    style.textContent = css();
    shadow.appendChild(style);

    var root = document.createElement("div");
    root.className = "mc-root";
    root.innerHTML = template();
    shadow.appendChild(root);

    document.body.appendChild(host);

    // 要素参照
    ui.launcher = root.querySelector(".mc-launcher");
    ui.panel = root.querySelector(".mc-panel");
    ui.closeBtn = root.querySelector(".mc-close");
    ui.body = root.querySelector(".mc-body");
    ui.presets = root.querySelector(".mc-presets");
    ui.form = root.querySelector(".mc-form");
    ui.input = root.querySelector(".mc-input");
    ui.send = root.querySelector(".mc-send");
    ui.tray = root.querySelector(".mc-tray-toggle");
    ui.trayTxt = root.querySelector(".mc-tray-txt");
    ui.presets.id = "mc-presets";
    ui.tray.addEventListener("click", function () { setTray(!trayOpen); });
    setTray(trayOpen);   // ラベルと実際の開閉状態を初期化時に合わせる

    // 起動直後だけ、ランチャーで「ここから質問できる」とそっと気づかせる
    // （数回ふわっと光って自然に止まる。reduced-motion 環境では無効）
    ui.launcher.classList.add("mc-attention");

    // イベント
    ui.launcher.addEventListener("click", togglePanel);
    ui.closeBtn.addEventListener("click", closePanel);
    // 入力の有無で送信ボタンを活性/非活性に（押せるか一目で分かる＝迷わせない）
    ui.input.addEventListener("input", updateSendState);
    ui.form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = ui.input.value.trim();
      if (!text) return;
      ui.input.value = "";
      updateSendState();
      handleUserMessage(text);
    });
    // Escでパネルを閉じる（開いている時のみ）
    root.addEventListener("keydown", function (e) {
      if ((e.key === "Escape" || e.keyCode === 27) && opened) {
        e.preventDefault();
        closePanel();
      }
    });
  }

  function template() {
    return (
      '<button class="mc-launcher" aria-label="チャットを開く">' +
        chatIcon() +
        (CONFIG.launcherLabel ? '<span class="mc-launcher-label">' + esc(CONFIG.launcherLabel) + "</span>" : "") +
      "</button>" +
      '<section class="mc-panel" role="dialog" aria-label="' + esc(CONFIG.title) + '">' +
        '<header class="mc-header">' +
          '<div class="mc-header-txt">' +
            '<strong>' + esc(CONFIG.title) + "</strong>" +
            '<span>' + esc(CONFIG.subtitle) + "</span>" +
          "</div>" +
          '<button class="mc-close" aria-label="閉じる">×</button>' +
        "</header>" +
        '<div class="mc-body" role="log" aria-live="polite" aria-atomic="false"></div>' +
        '<div class="mc-presets"></div>' +
        '<button class="mc-tray-toggle" type="button" aria-expanded="true" aria-controls="mc-presets">' +
          '<span class="mc-tray-txt">よくある質問から選ぶ</span><span class="mc-tray-caret">▾</span>' +
        "</button>" +
        '<form class="mc-form">' +
          '<input class="mc-input" type="text" placeholder="' + esc(CONFIG.placeholder) + '" autocomplete="off" enterkeyhint="send" inputmode="text" />' +
          '<button class="mc-send" type="submit" aria-label="送信" disabled>' + sendIcon() + "</button>" +
        "</form>" +
      "</section>"
    );
  }

  // ============================================================
  // メッセージ描画
  // ============================================================
  // ユーザーが「動きを減らす」設定にしているか（アニメ・スムーススクロールの抑制に使う）
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // 本文を最下部までスクロール。急に飛ばず滑らかに（チラつき・酔いを防ぐ）。
  function scrollBodyToEnd() {
    if (!ui.body) return;
    try {
      ui.body.scrollTo({ top: ui.body.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } catch (e) {
      ui.body.scrollTop = ui.body.scrollHeight; // 古いブラウザ向けフォールバック
    }
  }

  // 入力が空なら送信ボタンを無効化（押せる／押せないが見た目で分かる）
  function updateSendState() {
    if (!ui.send) return;
    ui.send.disabled = !(ui.input && ui.input.value.trim().length);
  }

  function addMessage(html, who) {
    var row = document.createElement("div");
    row.className = "mc-msg mc-msg--" + who; // who: "bot" or "user"
    var bubble = document.createElement("div");
    bubble.className = "mc-bubble";
    if (who === "user") {
      bubble.textContent = html; // ユーザー入力はテキスト扱い（XSS防止）
    } else {
      bubble.innerHTML = html;   // bot側はfaq.jsonの信頼できるHTMLのみ
    }
    row.appendChild(bubble);
    ui.body.appendChild(row);
    scrollBodyToEnd();
  }

  function handleUserMessage(text, source) {
    addMessage(text, "user");
    setTray(false);   // 回答を読むための場所を空ける（下の「よくある質問」で開き直せる）
    showTyping();
    // 少し間を置いて返答（自然な見た目）
    setTimeout(function () {
      hideTyping();
      var ranked = rankAnswers(text);
      var top = ranked[0];
      var hit = null;
      // 応対の結果種別。未回答ログを「育てる」ための分類軸：
      //   answered  … 確信ありで即回答できた
      //   ambiguous … 上位僅差で候補提示（意図は近いが1つに絞れない）
      //   suggested … 低スコアだが「もしかして」候補を提示（言い換え不足の疑い）
      //   fallback  … 手がかりゼロ＝カテゴリ誘導（新規FAQが必要な本命）
      var outcome = "fallback";

      // 上位が僅差で複数並ぶ（例:「違いを教えて」）＝質問が曖昧。
      // 勝手に1つに決めず、近い候補を提示してどれか選んでもらう。
      var nearTop = top ? ranked.filter(function (r) {
        return r.score >= top.score * AMBIGUOUS_RATIO;
      }).slice(0, 3) : [];

      if (top && top.score >= CONFIDENT_SCORE && nearTop.length >= 2) {
        outcome = "ambiguous";
        addMessage("近いご質問が複数あります。どれについてお答えしましょうか？👇", "bot");
        renderSuggestions(nearTop.map(function (r) { return r.item; }));
      } else if (top && top.score >= CONFIDENT_SCORE) {
        // 【確信あり】そのまま回答
        outcome = "answered";
        hit = top.item;
        addMessage("<div class=\"mc-ans-q\">" + esc(hit.q) + "</div>" + hit.answer, "bot");
        renderRelated(hit);            // 同じカテゴリの関連質問をすすめる
        renderFeedback(text);          // 「解決しましたか？」で“自信あり×的外れ”を捕捉
      } else {
        // 候補を絞り込む（一定スコア以上のものを上位3件まで）
        var suggestions = ranked.filter(function (r) {
          return r.score >= SUGGEST_SCORE;
        }).slice(0, 3).map(function (r) { return r.item; });

        if (suggestions.length) {
          // 【意図はつかめたが断定できない】近い質問を提示して回答へ誘導
          outcome = "suggested";
          addMessage("ご質問はこちらのことでしょうか？近いものを選んでいただくと、お答えできます👇", "bot");
          renderSuggestions(suggestions);
        } else {
          // 【手がかりなし】カテゴリから探してもらう
          outcome = "fallback";
          addMessage(DATA.fallback, "bot");
          renderCategoryMenu();
          setTray(true);   // 「ここから探してください」と促す以上、選択肢は見えていないと意味がない
        }
      }
      // 質問をスプレッドシートに記録（結果種別つき。hitは後方互換で残す）
      logQuestion(text, hit, source || "input", outcome);
    }, 450);
  }

  // 確信回答の直後に出す「解決しましたか？」フィードバック。
  // 押されるまでログ上は answered。押下で resolved / unresolved を追記送信する。
  // unresolved は“自信を持って答えたのに的外れ”という、今まで不可視だったケース。
  function renderFeedback(originalQuestion) {
    var wrap = document.createElement("div");
    wrap.className = "mc-related mc-feedback";
    wrap.innerHTML = '<div class="mc-related-label">解決しましたか？</div>';
    var done = false;
    // 選んだ瞬間に「押せた」と分かるように：選んだ方を塗りつぶし、もう片方を薄く固定。
    // 押したのに無反応…という不安をなくす（誤連打もここで止まる）。
    function lockChoice(chosen) {
      [yes, no].forEach(function (b) {
        b.disabled = true;
        if (b === chosen) b.classList.add("mc-chip--chosen");
      });
    }
    var yes = makeChip("👍 解決した", "mc-chip mc-chip--related", function () {
      if (done) return; done = true;
      lockChoice(yes);
      logQuestion(originalQuestion, null, "feedback", "resolved");
      addMessage("ありがとうございます！またいつでもご質問ください🌊", "bot");
    });
    var no = makeChip("解決しなかった", "mc-chip mc-chip--back", function () {
      if (done) return; done = true;
      lockChoice(no);
      logQuestion(originalQuestion, null, "feedback", "unresolved");
      addMessage(
        "お役に立てず申し訳ありません。スタッフが直接お答えしますので、" +
        "こちらからお問い合わせください → " +
        '<a href="https://mellow-wet.jp/contact.html" target="_blank" rel="noopener">お問い合わせフォーム</a>',
        "bot"
      );
    });
    wrap.appendChild(yes);
    wrap.appendChild(no);
    ui.body.appendChild(wrap);
    scrollBodyToEnd();
  }

  // ============================================================
  // 入力中インジケーター（… のアニメーション）
  // ============================================================
  var typingRow = null;
  function showTyping() {
    if (typingRow) return;
    typingRow = document.createElement("div");
    typingRow.className = "mc-msg mc-msg--bot";
    typingRow.innerHTML = '<div class="mc-bubble mc-typing"><span></span><span></span><span></span></div>';
    ui.body.appendChild(typingRow);
    scrollBodyToEnd();
  }
  function hideTyping() {
    if (typingRow && typingRow.parentNode) typingRow.parentNode.removeChild(typingRow);
    typingRow = null;
  }

  // ============================================================
  // 質問ログ送信（Googleスプレッドシートへ追記）
  // 失敗してもチャット動作には一切影響しない「投げっぱなし」方式。
  // GASのウェブアプリはCORSヘッダを返さないため、no-cors / sendBeacon で送る。
  // ============================================================
  // 質問文に紛れ込みやすい個人情報（メール/電話）を伏字化してから記録する
  function maskPII(s) {
    return String(s == null ? "" : s)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[メール]")
      .replace(/0\d{1,3}[-(\s]?\d{1,4}[-)\s]?\d{3,4}/g, "[電話]");
  }
  // UAはOS/ブラウザ程度の要約だけ記録（フル送信は個人特定性が高く不要）
  function shortUA() {
    var ua = navigator.userAgent || "";
    var os = /iPhone|iPad|iPod/.test(ua) ? "iOS"
           : /Android/.test(ua) ? "Android"
           : /Windows/.test(ua) ? "Windows"
           : /Mac OS X/.test(ua) ? "Mac"
           : /Linux/.test(ua) ? "Linux" : "Other";
    var br = /Edg\//.test(ua) ? "Edge"
           : /CriOS|Chrome\//.test(ua) ? "Chrome"
           : /Firefox\//.test(ua) ? "Firefox"
           : /Safari\//.test(ua) ? "Safari" : "Other";
    return os + " / " + br;
  }

  function logQuestion(question, hit, source, outcome) {
    if (!CONFIG.logUrl) return;                         // 未設定なら何もしない
    if (source === "preset" && !CONFIG.logPresetClicks) return;
    try {
      var payload = JSON.stringify({
        token: CONFIG.logToken || "",                   // スパム対策トークン（GAS側で照合）
        question: maskPII(question).slice(0, 500),      // PII伏字＋長さ上限
        matched: hit ? hit.q : "",                      // 一致したFAQの質問文（なければ空）
        hit: !!hit,                                     // true=回答できた / false=フォールバック
        outcome: outcome || "",                         // answered/ambiguous/suggested/fallback/resolved/unresolved
        source: source,                                 // "input"（自由入力）or "preset"（ボタン）or "feedback"
        page: location.href,                            // 質問が出たページ
        ua: shortUA()                                   // OS/ブラウザの要約のみ
      });
      // sendBeacon が使えれば最優先（離脱時も確実に送れる）
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: "text/plain;charset=UTF-8" });
        if (navigator.sendBeacon(CONFIG.logUrl, blob)) return;
      }
      // フォールバック: no-cors fetch（応答は読まない）
      fetch(CONFIG.logUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: payload,
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* ログ失敗は無視 */ }
  }

  // 小さなヘルパー：ボタン（チップ）を作る
  function makeChip(label, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // ------------------------------------------------------------
  // 選択肢エリアの開閉
  // ------------------------------------------------------------
  // 選択肢はパネルの半分近くを占めるため、会話が始まっても開いたままだと
  // 肝心の回答が画面外に押し出される。質問を送った時点で畳み、
  // 答えを出せずカテゴリへ誘導する時だけ開き直す。
  var trayOpen = true;
  function setTray(open) {
    trayOpen = open;
    ui.presets.classList.toggle("mc-hidden-tray", !open);
    ui.tray.classList.toggle("mc-tray--closed", !open);
    ui.tray.setAttribute("aria-expanded", open ? "true" : "false");
    if (ui.trayTxt) ui.trayTxt.textContent = open ? "閉じる" : "よくある質問から選ぶ";
    // 開閉で本文の高さが変わる。直前のメッセージが隠れたままにならないよう追従させる。
    setTimeout(scrollBodyToEnd, 0);
  }

  // ------------------------------------------------------------
  // 下部の選択肢エリア
  // ------------------------------------------------------------
  // FAQが増えるほど「全部並べる」は破綻するので、3階層に分けて
  // 各階層の選択肢を絞る。どの階層でも見出しで“いま何を選んでいるか”を示し、
  // 戻り先を必ず用意する（迷子にしない）。
  //   ① トップ      … すぐ押せる質問4件 ＋ カテゴリを開く入口 ＋ 問い合わせ
  //   ② カテゴリ一覧 … 件数つきのカテゴリ
  //   ③ 質問一覧    … そのカテゴリの質問
  // ------------------------------------------------------------

  // 見出し行（現在地の表示＋戻るボタン）。onBack を渡した時だけ戻るが出る。
  function presetsHead(text, onBack) {
    var head = document.createElement("div");
    head.className = "mc-presets-head";
    var label = document.createElement("span");
    label.className = "mc-presets-label";
    label.textContent = text;
    head.appendChild(label);
    if (onBack) {
      var back = document.createElement("button");
      back.type = "button";
      back.className = "mc-back";
      back.textContent = "← 戻る";
      back.addEventListener("click", onBack);
      head.appendChild(back);
    }
    ui.presets.appendChild(head);
  }

  function faqsIn(cat) {
    return DATA.faqs.filter(function (f) { return f.category === cat.id; });
  }

  // すぐ押せる質問を選ぶ。faq.json に "popular": true があればそれを、
  // 無ければ各カテゴリの先頭（＝そのカテゴリの代表的な質問）を拾う。
  function quickPickFaqs(n) {
    var picked = DATA.faqs.filter(function (f) { return f.popular; }).slice(0, n);
    if (picked.length >= n) return picked;
    var seen = {};
    picked.forEach(function (f) { seen[f.q] = true; });
    (DATA.categories || []).forEach(function (cat) {
      if (picked.length >= n) return;
      var first = faqsIn(cat)[0];
      if (first && !seen[first.q]) { picked.push(first); seen[first.q] = true; }
    });
    return picked.slice(0, n);
  }

  function questionChip(item) {
    return makeChip(item.q, "mc-chip", function () {
      handleUserMessage(item.q, "preset");
    });
  }

  // 答えにたどり着けなかった人の逃げ道。どの階層からも1タップで出られる。
  function appendContactChip() {
    if (!CONFIG.contactUrl) return;
    var a = document.createElement("a");
    a.className = "mc-chip mc-chip--contact";
    a.href = CONFIG.contactUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = CONFIG.contactLabel;
    ui.presets.appendChild(a);
  }

  // ① トップ：具体的な質問をまず見せる
  function renderCategoryMenu() {
    ui.presets.innerHTML = "";
    ui.presets.scrollTop = 0;

    if (!(DATA.categories && DATA.categories.length)) {
      // 後方互換：カテゴリ定義が無い faq.json でも従来どおり動く
      presetsHead("よくある質問");
      DATA.faqs.slice(0, CONFIG.maxPresets).forEach(function (item) {
        ui.presets.appendChild(questionChip(item));
      });
      appendContactChip();
      return;
    }

    var picks = quickPickFaqs(CONFIG.quickPicks);
    if (picks.length) {
      presetsHead("よくある質問");
      picks.forEach(function (item) { ui.presets.appendChild(questionChip(item)); });
    }
    ui.presets.appendChild(makeChip(
      "📂 カテゴリから探す（全" + DATA.faqs.length + "件）",
      "mc-chip mc-chip--cat",
      renderCategoryList
    ));
    appendContactChip();
  }

  // ② カテゴリ一覧：件数を出して「どれくらい載っているか」を伝える
  function renderCategoryList() {
    ui.presets.innerHTML = "";
    ui.presets.scrollTop = 0;
    presetsHead("カテゴリから探す", renderCategoryMenu);
    DATA.categories.forEach(function (cat) {
      var n = faqsIn(cat).length;
      if (!n) return;
      ui.presets.appendChild(makeChip(cat.label + " " + n, "mc-chip mc-chip--cat", function () {
        renderCategoryQuestions(cat);
      }));
    });
    appendContactChip();
  }

  // ③ 質問一覧：見出しにカテゴリ名を出す（どこを見ているか分かるように）
  function renderCategoryQuestions(cat) {
    ui.presets.innerHTML = "";
    ui.presets.scrollTop = 0;
    var items = faqsIn(cat);
    presetsHead(cat.label + "（" + items.length + "件）", renderCategoryList);
    items.forEach(function (item) { ui.presets.appendChild(questionChip(item)); });
    appendContactChip();
  }

  // 断定できなかった時：意図の近いFAQ候補を本文に提示し、回答へ誘導する。
  // クリックすると質問文そのもので再検索 → 確実に該当の回答が返る。
  function renderSuggestions(items) {
    var wrap = document.createElement("div");
    wrap.className = "mc-related";
    wrap.innerHTML = '<div class="mc-related-label">もしかして、こちらですか？</div>';
    items.forEach(function (item) {
      wrap.appendChild(makeChip(item.q, "mc-chip mc-chip--suggest", function () {
        handleUserMessage(item.q, "preset");
      }));
    });
    // どれも違う場合の逃げ道
    wrap.appendChild(makeChip("どれも違う／カテゴリから探す", "mc-chip mc-chip--back", function () {
      addMessage(DATA.fallback, "bot");
      renderCategoryMenu();
      setTray(true);
    }));
    ui.body.appendChild(wrap);
    scrollBodyToEnd();
  }

  // 回答のあと：同カテゴリの別の質問を「あわせて読まれています」として本文に提示
  function renderRelated(hit) {
    if (!hit || !hit.category) return;
    // 回答の下には「関連質問」と「解決しましたか？」が続けて出る。
    // 3件だとボタンが5つ縦に積まれて主役の回答が埋もれるため2件に絞る。
    var related = DATA.faqs.filter(function (f) {
      return f.category === hit.category && f.q !== hit.q;
    }).slice(0, 2);
    if (!related.length) return;

    var wrap = document.createElement("div");
    wrap.className = "mc-related";
    wrap.innerHTML = '<div class="mc-related-label">こちらもよく見られています</div>';
    related.forEach(function (item) {
      wrap.appendChild(makeChip(item.q, "mc-chip mc-chip--related", function () {
        handleUserMessage(item.q, "preset");
      }));
    });
    ui.body.appendChild(wrap);
    scrollBodyToEnd();
  }

  var opened = false;
  var greeted = false;
  function togglePanel() { opened ? closePanel() : openPanel(); }
  function openPanel() {
    opened = true;
    ui.launcher.classList.remove("mc-attention"); // 一度開いたら注目アニメは不要
    ui.panel.classList.add("mc-open");
    ui.launcher.classList.add("mc-hidden");
    if (!greeted) {
      greeted = true;
      if (DATA.greeting) addMessage(DATA.greeting, "bot");
      renderCategoryMenu();
    }
    setTimeout(function () { ui.input && ui.input.focus(); }, 200);
  }
  function closePanel() {
    opened = false;
    ui.panel.classList.remove("mc-open");
    ui.launcher.classList.remove("mc-hidden");
    // フォーカスをランチャーへ戻す（キーボード操作・スクリーンリーダー対応）
    try { ui.launcher.focus(); } catch (e) { /* noop */ }
  }

  // ============================================================
  // アイコン & エスケープ
  // ============================================================
  function chatIcon() {
    return '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 3C6.48 3 2 6.94 2 11.5c0 2.3 1.16 4.37 3.02 5.86-.13 1.1-.6 2.5-1.52 3.64 1.7-.2 3.3-.86 4.55-1.7 1.2.38 2.5.6 3.95.6 5.52 0 10-3.94 10-8.5S17.52 3 12 3z"/></svg>';
  }
  function sendIcon() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 20.5l18-8.5L3 3.5v6l12 2.5L3 14.5z"/></svg>';
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ============================================================
  // スタイル（Shadow DOM 内なのでサイトに影響しない）
  // ============================================================
  function css() {
    var a = CONFIG.accent, at = CONFIG.accentText;
    // 6桁HEXのアクセント色なら、α付き派生色（フォーカスリング・パルス光彩）を作れる。
    // それ以外（rgb()や名前色）の場合は無難なニュートラル値にフォールバック。
    var isHex = /^#[0-9a-fA-F]{6}$/.test(a);
    var glow  = isHex ? a + "59" : "rgba(13,110,140,.35)"; // フォーカスリング/光彩（不透明側）
    var glow0 = isHex ? a + "00" : "rgba(13,110,140,0)";   // 同色の透明（パルス終端）
    return "" +
    ".mc-root{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;}" +
    ".mc-root *{box-sizing:border-box;}" +
    // ランチャー
    ".mc-launcher{position:fixed;right:calc(20px + env(safe-area-inset-right,0px));bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;align-items:center;gap:8px;border:none;cursor:pointer;background:" + a + ";color:" + at + ";padding:14px 18px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:15px;font-weight:bold;transition:transform .15s,opacity .15s,box-shadow .15s;}" +
    ".mc-launcher:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.3);}" +
    ".mc-launcher:active{transform:translateY(0) scale(.97);}" +
    ".mc-launcher:focus-visible{outline:none;box-shadow:0 0 0 4px " + glow + ",0 6px 20px rgba(0,0,0,.25);}" +
    ".mc-launcher.mc-hidden{opacity:0;pointer-events:none;transform:scale(.8);}" +
    ".mc-launcher.mc-attention{animation:mc-pulse 2.2s ease-out .8s 3;}" +
    ".mc-launcher-label{line-height:1;}" +
    "@keyframes mc-pulse{0%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 0 " + glow + ";}70%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 14px " + glow0 + ";}100%{box-shadow:0 6px 20px rgba(0,0,0,.25),0 0 0 0 " + glow0 + ";}}" +
    // パネル
    ".mc-panel{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:360px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .2s,transform .2s;}" +
    ".mc-panel.mc-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}" +
    // ヘッダー
    ".mc-header{background:" + a + ";color:" + at + ";padding:16px 18px;display:flex;align-items:center;justify-content:space-between;}" +
    ".mc-header-txt{display:flex;flex-direction:column;gap:2px;}" +
    ".mc-header-txt strong{font-size:16px;}" +
    ".mc-header-txt span{font-size:12px;opacity:.9;}" +
    // 閉じるは指で押す前提。44px確保（Appleのタップ領域の推奨に合わせる）
    ".mc-close{background:transparent;border:none;color:" + at + ";font-size:24px;line-height:1;cursor:pointer;width:44px;height:44px;margin:-5px -8px -5px 0;border-radius:10px;display:flex;align-items:center;justify-content:center;opacity:.9;transition:background .12s,opacity .12s;flex:none;}" +
    ".mc-close:hover{opacity:1;background:rgba(255,255,255,.16);}" +
    ".mc-close:focus-visible{outline:2px solid " + at + ";outline-offset:2px;}" +
    // 本文
    ".mc-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:16px;background:#f5f7f9;display:flex;flex-direction:column;gap:10px;}" +
    ".mc-msg{display:flex;animation:mc-msg-in .25s ease;}" +
    "@keyframes mc-msg-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}" +
    ".mc-msg--bot{justify-content:flex-start;}" +
    ".mc-msg--user{justify-content:flex-end;}" +
    ".mc-bubble{max-width:82%;padding:11px 14px;border-radius:14px;font-size:14px;line-height:1.65;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.05);}" +
    ".mc-msg--bot .mc-bubble{background:#fff;color:#222;border:1px solid #e3e8ec;border-bottom-left-radius:4px;}" +
    ".mc-msg--user .mc-bubble{background:" + a + ";color:" + at + ";border-bottom-right-radius:4px;}" +
    ".mc-bubble a{color:" + a + ";font-weight:bold;text-decoration:underline;}" +
    ".mc-msg--user .mc-bubble a{color:" + at + ";}" +
    ".mc-ans-q{font-weight:bold;margin-bottom:4px;color:" + a + ";}" +
    // 入力中インジケーター（… のドット）
    ".mc-typing{display:flex;align-items:center;gap:4px;}" +
    ".mc-typing span{width:7px;height:7px;border-radius:50%;background:#b3c0c8;display:inline-block;animation:mc-blink 1.2s infinite both;}" +
    ".mc-typing span:nth-child(2){animation-delay:.2s;}" +
    ".mc-typing span:nth-child(3){animation-delay:.4s;}" +
    "@keyframes mc-blink{0%,80%,100%{opacity:.3;}40%{opacity:1;}}" +
    // 関連質問（回答の下に出る「こちらもよく見られています」）
    ".mc-related{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;}" +
    ".mc-related-label{width:100%;font-size:11.5px;color:#7a8a93;margin-bottom:2px;}" +
    // プリセット（選択肢エリア）。FAQが52件に増えたので、狭い帯に押し込まず
    // パネルの4割程度まで使う。会話ログとの境目は上の罫線＋背景差で示す。
    ".mc-presets{display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;padding:0 12px 12px;border-top:1px solid #e3e8ec;background:#fff;max-height:46%;overflow-y:auto;overscroll-behavior:contain;}" +
    // 見出し行：現在地＋戻る。長い一覧をスクロールしても消えないよう上に貼り付ける
    // （流れて消えると、どこにいるのか・どう戻るのかが分からなくなる）。
    ".mc-presets-head{position:sticky;top:0;z-index:1;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0 5px;background:#fff;}" +
    ".mc-presets-head:not(:first-child){margin-top:6px;border-top:1px solid #f0f3f5;padding-top:10px;}" +
    ".mc-presets-label{font-size:11.5px;color:#7a8a93;}" +
    ".mc-back{border:none;background:transparent;color:" + a + ";font-size:12px;font-weight:bold;cursor:pointer;padding:4px 8px;border-radius:8px;flex:none;}" +
    ".mc-back:hover{background:#eef4f7;}" +
    ".mc-back:focus-visible{outline:2px solid " + a + ";outline-offset:1px;}" +
    ".mc-chip{border:1px solid " + a + ";color:" + a + ";background:#fff;border-radius:999px;padding:8px 14px;min-height:38px;display:inline-flex;align-items:center;font-size:12.5px;line-height:1.35;cursor:pointer;transition:background .12s,color .12s,transform .08s;text-align:left;text-decoration:none;}" +
    ".mc-chip:hover{background:" + a + ";color:" + at + ";}" +
    ".mc-chip:active{transform:scale(.97);}" +
    ".mc-chip:focus-visible{outline:2px solid " + a + ";outline-offset:2px;}" +
    // フィードバック選択後：押せなくし、選んだ方だけ塗りつぶして“決定”を伝える
    ".mc-chip:disabled{cursor:default;opacity:.45;}" +
    ".mc-chip--chosen{opacity:1!important;}" +
    ".mc-chip--chosen.mc-chip--related{background:" + a + ";color:" + at + ";border-color:" + a + ";}" +
    ".mc-chip--chosen.mc-chip--back{background:#5a6a72;color:#fff;border-color:#5a6a72;}" +
    ".mc-chip--cat{font-weight:bold;}" +
    // 問い合わせは「答えが出なかった時の出口」なので、質問チップとは別物に見せる
    ".mc-chip--contact{width:100%;justify-content:center;margin-top:6px;border-style:dashed;border-color:#c9d3d9;color:#5a6a72;font-weight:bold;}" +
    ".mc-chip--contact:hover{background:#5a6a72;color:#fff;border-color:#5a6a72;border-style:solid;}" +
    ".mc-chip--back{border-color:#c9d3d9;color:#5a6a72;}" +
    ".mc-chip--back:hover{background:#5a6a72;color:#fff;}" +
    ".mc-chip--back:focus-visible{outline-color:#5a6a72;}" +
    ".mc-chip--related{font-size:12px;background:#f0f5f7;border-color:#dbe4e8;}" +
    ".mc-chip--suggest{font-size:12.5px;background:#fff;border-color:" + a + ";font-weight:bold;}" +
    // 選択肢エリアの開閉バー。畳んでいる間も「まだ選択肢がある」と示し続ける。
    ".mc-tray-toggle{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:none;border-top:1px solid #eef1f3;background:#fff;color:#5a6a72;font-size:12px;font-weight:bold;padding:9px 12px;cursor:pointer;transition:background .12s;}" +
    ".mc-tray-toggle:hover{background:#f4f7f9;}" +
    ".mc-tray-toggle:focus-visible{outline:2px solid " + a + ";outline-offset:-2px;}" +
    ".mc-tray--closed{color:" + a + ";}" +
    ".mc-tray-caret{font-size:10px;transition:transform .15s;}" +
    ".mc-tray--closed .mc-tray-caret{transform:rotate(180deg);}" +
    ".mc-hidden-tray{display:none;}" +
    // 入力フォーム（font-size:16px = iOSの自動ズーム防止。タップしても画面が拡大しない）
    ".mc-form{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #eef1f3;background:#fff;}" +
    ".mc-input{flex:1;min-width:0;border:1px solid #ccd4da;border-radius:999px;padding:10px 14px;font-size:16px;outline:none;transition:border-color .12s,box-shadow .12s;}" +
    ".mc-input:focus{border-color:" + a + ";box-shadow:0 0 0 3px " + glow + ";}" +
    ".mc-send{border:none;background:" + a + ";color:" + at + ";width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;transition:opacity .12s,transform .08s;}" +
    ".mc-send:not(:disabled):hover{opacity:.9;}" +
    ".mc-send:not(:disabled):active{transform:scale(.92);}" +
    ".mc-send:focus-visible{outline:none;box-shadow:0 0 0 3px " + glow + ";}" +
    ".mc-send:disabled{opacity:.4;cursor:default;}" +
    // スクロールバーを細く控えめに（圧迫感を減らす）
    ".mc-body::-webkit-scrollbar,.mc-presets::-webkit-scrollbar{width:8px;}" +
    ".mc-body::-webkit-scrollbar-thumb,.mc-presets::-webkit-scrollbar-thumb{background:#cdd6db;border-radius:8px;}" +
    ".mc-body::-webkit-scrollbar-track,.mc-presets::-webkit-scrollbar-track{background:transparent;}" +
    // スマホ：実機の表示領域(dvh)に合わせ、ノッチ/ホームバーを避ける
    "@media (max-width:480px){.mc-panel{right:0;bottom:0;width:100vw;height:100vh;height:100dvh;max-width:100vw;max-height:100vh;max-height:100dvh;border-radius:0;}.mc-form{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));}.mc-launcher{right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));}}" +
    // 「動きを減らす」設定の人にはアニメ・スムーススクロールを止める（酔い・負担への配慮）
    "@media (prefers-reduced-motion:reduce){.mc-root *,.mc-panel,.mc-launcher,.mc-msg{transition:none!important;animation:none!important;}}";
  }

  // ============================================================
  // 起動
  // ============================================================
  function init() {
    buildUI();
    fetch(resolveDataUrl(), { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("faq.json HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        DATA.faqs = (data && data.faqs) || [];
        DATA.categories = (data && data.categories) || [];
        DATA.fallback = (data && data.fallback) || "お問い合わせフォームよりご連絡ください。";
        DATA.greeting = (data && data.greeting) || "";
        buildIndex();   // 検索用インデックス（意図・bi-gram）を前計算
      })
      .catch(function (err) {
        // 読み込み失敗時もウィジェット自体は動く（フォールバックのみ）
        DATA.fallback = "申し訳ありません、現在うまく読み込めませんでした。お問い合わせフォームよりご連絡ください。";
        if (window.console) console.error("[mellow-chat] faq.json 読み込み失敗:", err);
      });
  }

  // Node環境（テスト時）では内部ロジックを公開し、ブラウザでは通常起動する。
  // ブラウザには module が無いため、この分岐は本番動作に一切影響しない。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      _setData: function (d) {
        DATA.faqs = d.faqs || [];
        DATA.categories = d.categories || [];
        DATA.fallback = d.fallback || "";
        DATA.greeting = d.greeting || "";
        buildIndex();
      },
      rankAnswers: rankAnswers,
      findAnswer: findAnswer,
      normalize: normalize,
      CONFIDENT_SCORE: CONFIDENT_SCORE,
      SUGGEST_SCORE: SUGGEST_SCORE
    };
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* ------------------------------------------------------------------
   * 将来「本物のAI（Claude API）」化したくなったら:
   *   handleUserMessage() の中の findAnswer(text) 部分を、
   *   faq.json を知識源として渡すサーバーAPI（PHP or Firebase Functions）への
   *   fetch に差し替えるだけで移行できます。UIはそのまま流用可能。
   * ------------------------------------------------------------------ */
})();
