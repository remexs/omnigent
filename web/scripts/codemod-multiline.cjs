#!/usr/bin/env node
/**
 * Wrap multi-line JSX text blocks in L(), preserving surrounding whitespace.
 *
 * JSX text nodes carry leading/trailing newlines + indentation. We keep the
 * leading whitespace and trailing whitespace intact and only wrap the trimmed
 * English prose:  "\n  Hello world\n"  ->  "\n  {L("Hello world")}\n"
 */
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

function looksEnglish(t) {
  if (!t || t.length < 5) return false;
  if (!/[A-Za-z]{3,}/.test(t)) return false;
  if (t.includes("{") || t.includes("}")) return false;
  if (/\$\{/.test(t)) return false;
  if (/^[a-z ]+$/.test(t)) return false;
  if (/^[A-Z ]+$/.test(t)) return false;
  if (/^(https?:)?\/\//.test(t)) return false;
  if (/^\/[a-zA-Z]/.test(t)) return false;
  return true;
}

function escapeJs(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

const stats = { files: 0, wrapped: 0 };

function processFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const text = raw.trim();
      if (text && looksEnglish(text) && !raw.includes("{L(")) {
        // 计算前后空白
        const leading = raw.slice(0, raw.indexOf(text));
        const trailing = raw.slice(raw.indexOf(text) + text.length);
        // 新内容：leading + {L("text")} + trailing（保留换行）
        const newText = leading + `{L("${escapeJs(text)}")}` + trailing;
        edits.push({ start: node.getStart(sf), end: node.getEnd(), newText, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) return;
  let out = source;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    stats.wrapped++;
  }
  if (!out.includes('from "@/i18n"')) {
    const importLine = 'import { L } from "@/i18n";';
    let insertAt = 0;
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
        insertAt = Math.max(insertAt, stmt.getEnd());
      }
    }
    if (insertAt === 0) insertAt = sf.getStart();
    const nl = out.slice(0, insertAt).endsWith("\n") ? "" : "\n";
    out = out.slice(0, insertAt) + nl + importLine + out.slice(insertAt);
  }
  fs.writeFileSync(file, out);
  stats.files++;
}

function collectFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectFiles(p, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(p);
    }
  }
}

const files = [];
collectFiles(SRC, files);
console.error(`Scanning ${files.length} files...`);
files.forEach(processFile);
console.error(`Done: ${stats.files} files changed, ${stats.wrapped} text blocks wrapped.`);
