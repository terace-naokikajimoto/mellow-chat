// faq.json を「人が読める既存の体裁」のまま書き戻すシリアライザ。
// keywords は1行、それ以外は素直に改行する（JSON.stringify だと keywords が縦に伸びて差分が読めなくなる）。
// 使い方: import { formatFaq } from "./write-faq.mjs"
export function formatFaq(data) {
  const j = (v) => JSON.stringify(v);
  const L = [];
  L.push("{");
  L.push(`  "fallback": ${j(data.fallback)},`);
  L.push(`  "greeting": ${j(data.greeting)},`);
  L.push(`  "categories": [`);
  data.categories.forEach((c, i) => {
    L.push(`    { "id": ${j(c.id)}, "label": ${j(c.label)} }${i < data.categories.length - 1 ? "," : ""}`);
  });
  L.push(`  ],`);
  L.push(`  "faqs": [`);
  data.faqs.forEach((f, i) => {
    L.push(`    {`);
    L.push(`      "category": ${j(f.category)},`);
    L.push(`      "q": ${j(f.q)},`);
    L.push(`      "keywords": [${f.keywords.map(j).join(", ")}],`);
    L.push(`      "answer": ${j(f.answer)}`);
    L.push(`    }${i < data.faqs.length - 1 ? "," : ""}`);
  });
  L.push(`  ]`);
  L.push("}");
  return L.join("\n") + "\n";
}
