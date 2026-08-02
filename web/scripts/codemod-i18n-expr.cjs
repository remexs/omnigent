#!/usr/bin/env node
/**
 * Codemod pass 2: wrap UI strings in JS expressions with L().
 *
 * Pass 1 (codemod-i18n.cjs) handled JSX text nodes and string-literal props.
 * This pass targets strings inside JS expressions that render to the UI:
 *
 *   1. Object-literal properties with whitelisted names:
 *        { label: "Text" } / { title: "Text" } / { placeholder: "..." }
 *        -> { label: L("Text") }
 *   2. Call arguments to known UI-feedback functions:
 *        setError("Text") / showToast("Text") / toast("Text")
 *        -> setError(L("Text"))
 *   3. String branches of ternary / nullish expressions:
 *        cond ? "A" : "B"   -> cond ? L("A") : L("B")
 *        x ?? "Fallback"    -> x ?? L("Fallback")
 *   4. String literals inside JSX attribute expressions:
 *        emptyMessage={cond ? "A" : "B"}
 *
 * All rewrites are keyed on English source strings (same dictionary as
 * pass 1); unknown keys fall back to English at runtime.
 */
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

// Object-literal property names that carry user-facing text.
const TEXT_OBJ_PROPS = new Set([
  "label", "title", "placeholder", "ariaLabel", "aria-label", "description",
  "text", "message", "emptyText", "emptyMessage", "emptyTitle", "header",
  "footer", "confirmText", "cancelText", "submitText", "saveText", "okText",
  "errorText", "successText", "loadingText", "noResultsText", "searchText",
  "tooltip", "hint", "helpText", "helperText", "caption", "badge", "toastTitle",
  "toastDescription", "heading", "subtitle", "statusText", "prompt",
  "buttonText", "placeholderText", "titleText", "alt", "name", "filename",
  "buttonLabel", "inputLabel", "optionLabel", "sectionTitle",
]);

// Function calls whose string args are user-facing.
const TEXT_CALLS = new Set([
  "setError", "showToast", "toast", "setStatus", "notify", "setHelperText",
  "setSuccess", "setMessage", "setNotice", "addToast", "showMessage",
]);

// Skip list for call arg indices (0-based) — not used; we wrap ALL string
// args of whitelisted calls that look translatable.

function looksTranslatable(s) {
  if (!s || s.length < 2 || s.length > 160) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^[a-z_]+$/.test(s) && !s.includes(" ")) return false;
  if (/^[#@<>{}]/.test(s)) return false;
  if (/^(https?:)?\/\//.test(s)) return false;
  if (/^\d+[a-zA-Z]*$/.test(s)) return false;
  if (/\$\{/.test(s)) return false;
  if (/^[A-Z][a-zA-Z]+$/.test(s)) {
    // Single capitalized word: brand/token names stay English.
    const skip = new Set([
      "AI","API","HTTP","HTTPS","SSE","WebSocket","JSON","YAML","Markdown",
      "LLM","GPT","SDK","CLI","UI","URL","URI","UUID","ID","IP","DNS","TLS",
      "SSL","SQL","DB","HTML","CSS","JS","TS","XML","PDF","PNG","JPG","SVG",
      "GPU","CPU","RAM","FTP","SSH","Git","GitHub","Python","Node","npm",
      "pnpm","yarn","Docker","React","Vite","tmux","bwrap","OpenAI","Claude",
      "Omnigent","Codex","Cursor","Hermes","Kiro","Kimi","Qwen","Goose",
      "Copilot","Pi","Antigravity","OpenShell","E2B","Modal","Daytona",
      "Databricks","CoreWeave","Kubernetes","Boxlite","OpenCode","opencode",
      "debby","polly","Cancel","OK","Save","Edit","Delete","Copy","Close",
      "Open","Send","Run","Stop","Retry","Done","Back","Next","Add","Remove",
      "Share","Export","Import","Upload","Download","Refresh","Reload","Clear",
      "Search","Settings","Help","New","View","Show","Hide","Error","Warning",
      "Input","Output","Total","Read","Write","Mode","Host","Agent","Model",
      "Medium","High","Low","Name","Password","Username","Email","Default",
      "General","Appearance","Account","Server","Session","Message","Tool",
      "File","Files","Terminal","Shell","Policy","Policies","Status","Type",
      "Role","Owner","Member","Admin","Permission","Public","Private",
      "Approval","Goal","Effort","Prompt","Response","Question","Quote",
      "Action","Actions","Invite","Join","Leave","Pin","Archive","Rename",
      "Dismiss","Reset","Change","Configure","Update","Install","Uninstall",
      "Sign in","Sign out","Log out","Log in","Login","Register","Submit",
      "Continue","Finish","Start","Stop","Pause","Resume","Cancel","Approve",
      "Reject","Allow","Deny","Ask","Enable","Disable","On","Off","Yes","No",
    ]);
    if (skip.has(s)) return false;
  }
  // Skip pure placeholders/examples.
  if (/^(e\.g\.|e\.g\.\s)/.test(s)) return false;
  // Skip CSS-ish values (classes, transitions, var() refs, unit combos).
  if (/[{}:;]/.test(s)) return false;
  if (/^[a-z0-9][a-z0-9-]*(?:\s+[a-z0-9-]+)*$/.test(s) && s.includes("-")) return false; // kebab-case ids/classes like "oa-comment", "error-security", "login-username"
  if (/(^|\s)(border|bg|text|hover|focus|flex|grid|px-|py-|mx-|my-|mt-|mb-|ml-|mr-|gap-|w-|h-|min-|max-|rounded|shadow|transition|duration|ease-|absolute|relative|fixed|sticky|z-\d)[\s-]/.test(s)) return false;
  if (/^\s*[+-]?\s*var\(--/.test(s)) return false;  if (/^[a-z-]+\d*\.?\d*(ms|s|px|em|rem|%|vh|vw|fr|deg|turn)$/.test(s)) return false;
  if (/^[a-z-]+\s+\d/.test(s)) return false; // e.g. "transform 120ms ease-out"
  if (/^(zoom-in|zoom-out|pre-wrap|pre-line|nowrap|no-wrap|break-word|break-all|ellipsis|underline-thin|size-\d|size-\d\.\d)$/.test(s)) return false;
  return true;
}

function escapeJsString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const stats = { files: 0, wraps: 0 };

function processFile(file, dry) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Ensure parent pointers are set so isInsideClassName can walk up.
  const setParents = (n) => {
    n.forEachChild((c) => {
      c.parent = n;
      setParents(c);
    });
  };
  setParents(sf);
  const edits = [];

  function addEdit(start, end, newText) {
    edits.push({ span: { start, end }, newText });
  }

  function isInsideClassName(node) {
    // Walk up to find whether this string feeds a className / style attr.
    let cur = node.parent;
    while (cur) {
      if (ts.isJsxAttribute(cur) && cur.name.getText(sf) === "className") return true;
      if (ts.isJsxAttribute(cur) && cur.name.getText(sf) === "style") return true;
      if (ts.isPropertyAssignment(cur) && cur.name.getText(sf) === "className") return true;
      if (ts.isPropertyAssignment(cur) && cur.name.getText(sf) === "style") return true;
      if (ts.isSourceFile(cur)) break;
      cur = cur.parent;
    }
    return false;
  }

  function wrapIfTranslatable(node) {
    // Never wrap strings that feed a className / style attribute or property.
    if (isInsideClassName(node)) return false;
    if (ts.isStringLiteral(node)) {
      const val = node.getText(sf).slice(1, -1);
      if (looksTranslatable(val)) {
        addEdit(node.getStart(sf), node.getEnd(), `L("${escapeJsString(val)}")`);
        stats.wraps++;
        return true;
      }
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      const raw = node.getText(sf).slice(1, -1);
      if (looksTranslatable(raw)) {
        addEdit(node.getStart(sf), node.getEnd(), `L("${escapeJsString(raw)}")`);
        stats.wraps++;
        return true;
      }
    }
    return false;
  }

  function visit(node) {
    // 1. Object-literal properties with whitelisted names.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (TEXT_OBJ_PROPS.has(name)) {
        wrapIfTranslatable(node.initializer);
        ts.forEachChild(node, visit);
        return;
      }
    }
    // 2. Call arguments to whitelisted functions.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if (TEXT_CALLS.has(fn)) {
        for (const arg of node.arguments) {
          wrapIfTranslatable(arg);
        }
        ts.forEachChild(node, visit);
        return;
      }
    }
    // 3. Ternary / nullish string branches.
    if (ts.isConditionalExpression(node)) {
      wrapIfTranslatable(node.whenTrue);
      wrapIfTranslatable(node.whenFalse);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      wrapIfTranslatable(node.right);
    }
    // 4. Logical-or fallback strings:  x || "Fallback"
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      wrapIfTranslatable(node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) return;

  let out = source;
  edits.sort((a, b) => b.span.start - a.span.start);
  for (const e of edits) {
    out = out.slice(0, e.span.start) + e.newText + out.slice(e.span.end);
  }
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
    let shown = 0;
    for (const e of edits.slice(0, 8)) {
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
console.error(`\nSummary: ${stats.files} files changed, ${stats.wraps} strings wrapped.`);
