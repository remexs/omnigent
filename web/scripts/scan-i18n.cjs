#!/usr/bin/env node
/**
 * Scan TSX files for translatable UI strings.
 *
 * Extracts:
 *  1. JSX text children:           >Hello world<
 *  2. String-literal JSX props:    title="Hello world"
 *  3. String literals in t(..)     (none yet)
 *
 * Writes a deduped report and the candidate list to stdout.
 */
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

// Props that ARE user-facing text.
const TEXT_PROPS = new Set([
  "title", "alt", "placeholder", "aria-label", "label", "description",
  "text", "emptyText", "emptyMessage", "emptyTitle", "message", "header",
  "footer", "confirmText", "cancelText", "submitText", "saveText", "okText",
  "errorText", "successText", "loadingText", "noResultsText", "searchText",
  "tooltip", "hint", "helpText", "helperText", "caption", "badge", "toastTitle",
  "toastDescription", "confirmLabel", "cancelLabel", "okLabel", "titleText",
  "heading", "subtitle", "statusText", "prompt", "inviteText", "buttonText",
  "placeholderText", "ariaLabel", "selectedLabel", "deselectedLabel",
]);

// English-like heuristic for a candidate string.
function looksTranslatable(s) {
  if (!s || s.length < 2 || s.length > 120) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  // Skip pure code-ish tokens.
  if (/^[a-z_]+$/.test(s) && !s.includes(" ")) return false;
  // Skip URLs, paths, css-ish, html entities, template syntax.
  if (/^[#@<>{}]/.test(s)) return false;
  if (/^(https?:)?\/\//.test(s)) return false;
  if (/^\d+[a-zA-Z]*$/.test(s)) return false;
  // Skip brand/technical tokens that stay English.
  const skip = new Set([
    "AI", "API", "HTTP", "HTTPS", "SSE", "WebSocket", "JSON", "YAML", "Markdown",
    "LLM", "GPT", "SDK", "CLI", "UI", "URL", "URI", "UUID", "ID", "IP", "DNS",
    "TLS", "SSL", "SQL", "DB", "HTML", "CSS", "JS", "TS", "XML", "PDF", "PNG",
    "JPG", "SVG", "GPU", "CPU", "RAM", "ROM", "FTP", "SSH", "Git", "GitHub",
    "Python", "Node", "npm", "pnpm", "yarn", "Docker", "React", "Vite", "tmux",
    "bwrap", "OpenAI", "Claude", "Omnigent", "Codex", "Cursor", "Hermes", "Kiro",
    "Kimi", "Qwen", "Goose", "Copilot", "Pi", "Antigravity", "OpenShell", "E2B",
    "Modal", "Daytona", "Databricks", "CoreWeave", "Kubernetes", "Boxlite",
    "OpenCode", "opencode", "debby", "polly", "claude", "codex",
  ]);
  if (skip.has(s.trim())) return false;
  return true;
}

const found = new Map(); // text -> Set(file)

function visitFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function add(text) {
    const t = text.trim();
    if (looksTranslatable(t)) {
      if (!found.has(t)) found.set(t, new Set());
      found.get(t).add(path.relative(SRC, file));
    }
  }

  function walk(node) {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf);
      if (text.includes("{{")) {
        // Skip text containing expressions; flag for manual review.
        const parts = text.split(/\{\{|\}\}/g);
        parts.forEach((p, i) => { if (i % 2 === 0 && looksTranslatable(p)) add(p); });
      } else {
        add(text);
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (ts.isStringLiteral(init)) {
        const val = init.getText(sf).slice(1, -1);
        if (TEXT_PROPS.has(name) || (name === "aria-label" && looksTranslatable(val))) {
          add(val);
        }
      } else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) {
        const val = init.expression.getText(sf).slice(1, -1);
        if (TEXT_PROPS.has(name) && looksTranslatable(val)) {
          add(val);
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
}

function collectFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "ui") continue;
      collectFiles(p, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(p);
    }
  }
}

const files = [];
collectFiles(SRC, files);
console.error(`Scanning ${files.length} TSX files...`);
files.forEach(visitFile);

// Report.
const sorted = [...found.entries()].sort((a, b) => b[1].size - a[1].size);
console.error(`Found ${sorted.length} unique translatable strings.`);
for (const [text, fileSet] of sorted) {
  console.log(JSON.stringify({ text, files: [...fileSet].slice(0, 5), count: fileSet.size }));
}
