# FAQ育成プロンプト（未回答ログ → faq.json 更新案）

チャットで「答えられなかった／的外れだった」質問を集めて、`public/faq.json` を育てるための指示テンプレです。
ランタイムでLLMは使わない設計なので、これは**保守作業としてのオフラインClaude**（Claude Code など）で回します。
サイトの事実そのものを更新したいときは、代わりに [`regen-faq-prompt.md`](./regen-faq-prompt.md) を使ってください。

---

## このループでやること

```
質問ログ（GASスプレッドシート）
   └─ 結果＝fallback / suggested / unresolved を書き出し
        └─ grow-faq-prompt（このファイル）でClaudeに渡す
             └─ (a)キーワード追加 / (b)新規Q&A / (c)対象外 に分類した faq.json 更新案
                  └─ 人がレビュー → FTPで public/faq.json 反映 → 回帰テスト
```

「結果」列の意味（`gas/Code.gs` と対応）:
- `fallback` … 手がかりゼロ。**新規FAQが必要**な本命候補。
- `suggested` … 候補は出せたが断定できず。**既存FAQのキーワード不足**の疑い。
- `unresolved` … 自信を持って回答したのにユーザーが「解決しなかった」。**回答内容のズレ**。
- `answered` / `resolved` … うまくいったケース（基本いじらない。重複登録の確認に使う程度）。

---

## 使い方

1. 未回答ログを書き出す。**自動（推奨）か手動のどちらか**:
   - **自動**: GASをデプロイ済みなら、エクスポート口から取得して集計まで一発:
     ```bash
     MELLOW_LOG_URL="https://script.google.com/macros/s/XXX/exec" \
     MELLOW_LOG_TOKEN="（SHARED_TOKENを設定した場合のみ）" \
     node tools/harvest-questions.mjs            # 直近30日（--days 60 / --all も可）
     ```
     → `tools/unanswered.json`（似た質問をまとめ、件数順）が出力される。これをそのまま下のClaudeに渡す。
   - **手動**: スプレッドシートを開き「結果」列を `fallback` / `suggested` / `unresolved` でフィルタして
     質問文ごと書き出す（コピペ or CSV）。
   - 期間の目安：前回からの差分（月1運用なら直近1か月）。
2. 必要ならサイトの最新コーパスも更新（新規FAQの事実根拠に使う）:
   ```bash
   node tools/crawl-site.mjs
   ```
3. 下の「指示文」をコピーして Claude に貼り、**書き出した未回答リストを一緒に渡して**実行してもらう。
4. 出てきた `public/faq.json` の差分を**人が確認**（特に新規Q&Aの事実・価格・固有名詞）。
5. 問題なければFTPで `public/faq.json` を上書きアップロード。
6. 回帰確認:
   ```bash
   node test/match.test.mjs
   node test/eval.mjs   # 300問の採点。「即回答で誤答」が増えていないこと
   python3 -c "import json;json.load(open('public/faq.json'))"
   ```

---

## 指示文（ここからコピー）

> あなたはメロー（mellow-wet.jp、オーダーメイド・ウェットスーツ）のFAQ運用担当です。
> 未回答ログ（`tools/unanswered.json`＝harvest-questions.mjs が集計した「answered できなかった質問」。
> 手動書き出しの場合は添付の一覧）をもとに、`public/faq.json` を育ててください。
> 情報源は `tools/site-content.json`（サイト全ページの自動取得コーパス）と現行 `public/faq.json` のみ。ルールは厳守:
>
> 1. **未回答ログを似た質問でクラスタリングし、件数の多い順に並べる。** 各クラスタに代表質問と件数を付ける。
> 2. 各クラスタを次の3つに分類し、対応案を出す:
>    - **(a) 既存FAQへのキーワード追加** … 既に答えはあるのに表記ゆれ・言い換えで拾えなかったもの
>      （`suggested` に多い）。どの `faq` の `examples` に、取りこぼした言い回しをそのまま足すかを具体的に示す（特徴的な語があれば `keywords` にも）。
>      表記ゆれ（ひらがな/漢字/英字/言い換え）を意識し、誤検出が増えない範囲で。
>    - **(b) 新規FAQ追加** … コーパスに事実があるのにFAQに無いトピック（`fallback` に多い）。
>      新しい `{category, q, keywords, examples, answer}` を作る（`examples` は訪問者が打ちそうな言い回し8〜12個）。`category` は既存 `categories[].id` のいずれか。
>      **事実はコーパスのみを根拠にし、無い数値・固有名詞・サービスを創作しない**
>      （存在しない料金・採寸方法・在庫などを書かない）。一般的な選び方・お手入れの助言は、
>      サイトの事実と矛盾しない範囲なら可。
>    - **(c) 対象外** … 商品・サービスと無関係（雑談・他社の話など）でFAQ化すべきでないもの。
>      FAQは増やさず、必要なら `fallback` 文言やエスカレーション導線の調整案だけ出す。
> 3. **`unresolved`（自信を持って答えたのに解決しなかった）は最優先で点検。** どのFAQの回答が
>    ズレている可能性があるかを指摘し、回答本文の修正案を出す（事実はコーパス根拠）。
> 4. **既存の構造・カテゴリ・トーンは維持。** スキーマは
>    `{ fallback, greeting, categories:[{id,label}], faqs:[{category,q,keywords,examples,answer}] }`。
>    `keywords` は各5〜12語（どの質問にも当てはまる語は入れない）。リンクは実在URLのみ（`contact.html` であって `contact/` ではない等）。
> 5. 必要なら、繰り返し現れる意図語（例 別の言い回し）を `public/chat-widget.js` の
>    `INTENT_GROUPS` に足す提案も出す（こちらはコード変更なので提案のみ。勝手に確定しない）。
> 6. 出力は次の2つ:
>    - **更新後の `public/faq.json` 全文**（差分が分かるように既存の良い回答は活かす）
>    - **要約**：「(a)キーワード追加 / (b)新規Q&A / (c)対象外 / unresolved修正 / INTENT_GROUPS提案」に
>      分けた箇条書き（各クラスタの代表質問と件数つき）。
> 7. JSONとして妥当であることを
>    `python3 -c "import json;json.load(open('public/faq.json'))"` で確認してから完了とすること。

---

## 定期自動化（任意）

毎月手で回す代わりに、`/schedule`（Claude Code のクラウド定期実行）で
「未回答ログの取得 → このプロンプトで faq.json 更新案を作成 → 結果を通知」まで自動化できます。
デプロイ（FTPアップ）と新規Q&Aの事実確認は**人の確認後**に行う運用がおすすめです。
設定したい場合はその旨を伝えてください。
