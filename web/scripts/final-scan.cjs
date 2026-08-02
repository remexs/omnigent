const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const dictSrc = fs.readFileSync("src/i18n/zh-CN.ts", "utf8");
const sf = ts.createSourceFile("z", dictSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const dict = new Set();
function collectDict(n) {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) dict.add(n.name.text);
  ts.forEachChild(n, collectDict);
}
collectDict(sf);

// 品牌/技术词（允许出现在 UI 中且不翻译）
const BRAND = new Set([
  "Claude", "Codex", "Cursor", "Hermes", "Kiro", "Kimi", "Qwen", "Goose",
  "Copilot", "Pi", "Antigravity", "Omnigent", "Polly", "Debby", "OpenCode",
  "OpenShell", "E2B", "Modal", "Daytona", "Databricks", "CoreWeave",
  "Kubernetes", "Boxlite", "Git", "GitHub", "Python", "Node", "Docker",
  "React", "Vite", "tmux", "bwrap", "AI", "API", "HTTP", "WebSocket", "JSON",
  "YAML", "Markdown", "LLM", "GPT", "SDK", "CLI", "UI", "URL", "PDF", "HTML",
  "CSS", "MCP", "SSE", "shell", "terminal",
]);

const issues = { missingL: new Set(), bareText: [], singleWord: [], objLabels: [] };

function looksBrand(s) {
  const words = s.split(/[\s,.\-()&/]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => BRAND.has(w));
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p);
    } else if (/\.tsx$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      const sf2 = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const rel = path.relative("src", p);

      function w2(n) {
        // L() 调用缺 key
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "L") {
          for (const a of n.arguments) {
            if (ts.isStringLiteral(a) && !dict.has(a.text) && !looksBrand(a.text)) {
              issues.missingL.add(a.text);
            }
          }
        }
        // JSX 裸英文文本（多词）
        if (ts.isJsxText(n)) {
          const t = n.getText(sf2).trim();
          if (
            t && /[A-Za-z]{3,}/.test(t) && t.includes(" ") &&
            !t.includes("{") && !t.includes("}") && !/\$/.test(t) &&
            !/^[a-z ]+$/.test(t) && !looksBrand(t)
          ) {
            issues.bareText.push(`${JSON.stringify(t.slice(0, 70))} <- ${rel}:${sf2.getLineAndCharacterOfPosition(n.getStart(sf2)).line + 1}`);
          }
        }
        // 三元/fallback 中的单大写词
        if (ts.isConditionalExpression(n)) {
          for (const br of [n.whenTrue, n.whenFalse]) {
            if (ts.isStringLiteral(br) && /^[A-Z][a-z]+$/.test(br.text) && !dict.has(br.text) && !BRAND.has(br.text)) {
              issues.singleWord.push(`${br.text} <- ${rel}:${sf2.getLineAndCharacterOfPosition(n.getStart(sf2)).line + 1}`);
            }
          }
        }
        if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
          if (ts.isStringLiteral(n.right) && /^[A-Z][a-z]+$/.test(n.right.text) && !dict.has(n.right.text) && !BRAND.has(n.right.text)) {
            issues.singleWord.push(`${n.right.text} <- ${rel}:${sf2.getLineAndCharacterOfPosition(n.getStart(sf2)).line + 1}`);
          }
        }
        ts.forEachChild(n, w2);
      }
      w2(sf2);
    }
  }
}
walk("src");

console.log("=== 最终扫描结果 ===");
console.log("A. L() 缺失:", issues.missingL.size);
for (const k of [...issues.missingL].sort()) console.log("  " + JSON.stringify(k.slice(0, 80)));
console.log("\nB. 裸英文 JSX 文本:", issues.bareText.length);
for (const t of issues.bareText.slice(0, 20)) console.log("  " + t);
console.log("\nC. 单大写词三元/fallback:", issues.singleWord.length);
for (const t of issues.singleWord.slice(0, 20)) console.log("  " + t);
console.log("\n总计问题:", issues.missingL.size + issues.bareText.length + issues.singleWord.length);
