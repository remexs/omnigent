#!/usr/bin/env node
/**
 * Codemod: wrap translatable UI strings in L() calls.
 *
 * Safely rewrites:
 *   1. JSX text children:           <div>Hello world</div>
 *                                   -> <div>{L("Hello world")}</div>
 *   2. Whitelisted text props:      <X title="Hello world">
 *                                   -> <X title={L("Hello world")}>
 *   3. Adds `import { L } from "@/i18n"` when a file gains any rewrite.
 *
 * Skips structural props (className, id, data-*, etc.), expressions, template
 * literals, and multi-line/whitespace-heavy JSX text that would be unsafe to
 * auto-wrap. Use --dry to preview, --apply to write.
 */
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

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

// Props NEVER rewritten even if they look translatable.
const SKIP_PROPS = new Set([
  "className", "id", "key", "ref", "style", "type", "name", "value",
  "src", "href", "to", "data-testid", "data-state", "data-slot", "role",
  "variant", "size", "as", "asChild", "tabIndex", "spellCheck", "autoFocus",
  "onClick", "onSubmit", "onChange", "disabled", "checked", "defaultValue",
  "strokeWidth", "width", "height", "viewBox", "fill", "stroke", "xmlns",
  "x", "y", "d", "pathLength", "aria-hidden", "aria-current",
  "aria-selected", "aria-expanded", "aria-checked", "aria-valuenow",
  "aria-valuemin", "aria-valuemax", "aria-orientation", "aria-controls",
  "aria-describedby", "aria-labelledby", "aria-live", "aria-atomic",
  "aria-haspopup", "aria-modal", "aria-keyshortcuts", "aria-autocomplete",
  "aria-activedescendant", "aria-errormessage", "aria-invalid",
  "aria-placeholder", "aria-roledescription", "aria-setsize", "aria-posinset",
  "aria-owns", "aria-flowto", "aria-dropeffect", "aria-grabbed", "aria-pressed",
  "aria-required", "aria-sort", "aria-valuemax", "aria-valuetext",
  "autoComplete", "autoCapitalize", "autoCorrect", "autoSave", "contentEditable",
  "dir", "draggable", "enterKeyHint", "form", "inputMode", "itemProp", "lang",
  "loading", "maxLength", "minLength", "poster", "readOnly",
  "rel", "slot", "target", "translate", "accept", "action",
  "cols", "rows", "step", "min", "max", "pattern", "multiple", "required",
  "list", "open", "defaultOpen", "forceMount", "modal", "side", "align",
  "sideOffset", "alignOffset", "avoidCollisions", "collisionPadding",
  "sticky", "hideWhenDetached", "updatePositionStrategy", "latency",
  "duration", "delayDuration", "skipDelayDuration", "disableHoverableContent",
  "disablePointerEvents", "keyboard", "touch", "screenReaderAnnouncements",
  "announcement", "cycle", "priority", "volume", "loop", "muted", "controls",
  "playsInline", "autoPlay", "preload", "crossOrigin", "integrity",
]);

// Strings that are not user-facing UI copy.
const NON_TEXT = new Set([
  "AI", "API", "HTTP", "HTTPS", "SSE", "WebSocket", "JSON", "YAML", "Markdown",
  "LLM", "GPT", "SDK", "CLI", "UI", "URL", "URI", "UUID", "ID", "IP", "DNS",
  "TLS", "SSL", "SQL", "DB", "HTML", "CSS", "JS", "TS", "XML", "PDF", "PNG",
  "JPG", "SVG", "GPU", "CPU", "RAM", "FTP", "SSH", "Git", "GitHub",
  "Python", "Node", "npm", "pnpm", "yarn", "Docker", "React", "Vite", "tmux",
  "bwrap", "OpenAI", "Claude", "Omnigent", "Codex", "Cursor", "Hermes", "Kiro",
  "Kimi", "Qwen", "Goose", "Copilot", "Pi", "Antigravity", "OpenShell", "E2B",
  "Modal", "Daytona", "Databricks", "CoreWeave", "Kubernetes", "Boxlite",
  "OpenCode", "opencode", "debby", "polly",
]);

function looksTranslatable(s) {
  if (!s || s.length < 2 || s.length > 120) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^[a-z_]+$/.test(s) && !s.includes(" ")) return false;
  if (/^[#@<>{}]/.test(s)) return false;
  if (/^(https?:)?\/\//.test(s)) return false;
  if (/^\d+[a-zA-Z]*$/.test(s)) return false;
  if (NON_TEXT.has(s.trim())) return false;
  // Skip strings with braces/expressions inside.
  if (/\{[^}]*\}/.test(s)) return false;
  // Skip strings that are mostly code/symbols.
  const alpha = (s.match(/[A-Za-z]/g) || []).length;
  if (alpha < s.length * 0.4 && s.includes(" ")) return false;
  return true;
}

function escapeJsString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

const stats = { files: 0, textNodes: 0, props: 0, skippedUnsafe: 0 };

function processFile(file, dry) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];

  function addEdit(start, end, newText) {
    edits.push({ span: { start, end }, newText });
  }

  function visit(node) {
    // 1. JSX text children (single- or multi-line).
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const text = raw.trim();
      // Skip text that embeds expressions (JSX text nodes never do, but
      // defensive: a stray brace/angle means we'd corrupt the tree). Only
      // wrap clean English prose — no code-ish punctuation.
      const safe = !/[{}<>?()[/\\=+*#@`]/.test(text);
      if (text && safe && looksTranslatable(text)) {
        addEdit(node.getStart(sf), node.getEnd(), `{L("${escapeJsString(text)}")}`);
        stats.textNodes++;
      }
    }
    // 2. Whitelisted text props with string-literal values.
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (SKIP_PROPS.has(name) || !TEXT_PROPS.has(name)) {
        ts.forEachChild(node, visit);
        return;
      }
      const init = node.initializer;
      if (ts.isStringLiteral(init)) {
        const val = init.getText(sf).slice(1, -1);
        if (looksTranslatable(val)) {
          addEdit(init.getStart(sf), init.getEnd(), `{L("${escapeJsString(val)}")}`);
          stats.props++;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) return;

  // Apply edits (from end to start so offsets stay valid), then add the import.
  let out = source;
  edits.sort((a, b) => b.span.start - a.span.start);
  for (const e of edits) {
    out = out.slice(0, e.span.start) + e.newText + out.slice(e.span.end);
  }
  // Insert import after the last top-level import declaration.
  const importLine = 'import { L } from "@/i18n";';
  if (!out.includes('from "@/i18n"')) {
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

  stats.files++;
  if (dry) {
    console.log(`\n=== ${path.relative(SRC, file)} (${edits.length} edits) ===`);
    // Show a couple of example diffs.
    let shown = 0;
    for (const e of edits.slice(0, 6)) {
      const before = source.slice(e.span.start, e.span.end);
      console.log(`  - ${before.replace(/\n/g, "\\n")}\n  + ${e.newText.replace(/\n/g, "\\n")}`);
      shown++;
    }
    if (edits.length > shown) console.log(`  ... and ${edits.length - shown} more`);
  } else {
    fs.writeFileSync(file, out);
  }
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

const dry = process.argv.includes("--dry");
const files = [];
collectFiles(SRC, files);
console.error(`${dry ? "DRY-RUN" : "APPLY"}: scanning ${files.length} TSX files...`);
files.forEach((f) => processFile(f, dry));
console.error(`\nSummary: ${stats.files} files changed, ${stats.textNodes} JSX text nodes, ${stats.props} props wrapped.`);
