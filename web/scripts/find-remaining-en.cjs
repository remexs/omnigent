const fs = require("fs");
const path = require("path");

// Find remaining English UI text:
//  1. JSX text nodes: >Hello world<  (no expressions)
//  2. String-literal props NOT wrapped in L() (title/placeholder/aria-label/etc.)
//  3. JS string literals used in common UI positions (toast, dialog, etc.)
const candidates = new Map();

function add(k, file, note) {
  if (!k || k.length < 3) return;
  const t = k.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim();
  if (!/[A-Za-z]{2,}/.test(t)) return;
  if (/^[a-z_]+$/.test(t)) return;
  if (!candidates.has(t)) candidates.set(t, new Set());
  candidates.get(t).add(path.relative("src", file) + (note ? " " + note : ""));
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p);
    } else if (/\.tsx$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      // 1. JSX text nodes.
      for (const m of src.matchAll(/>([^<>{]*[A-Za-z]{2,}[^<>{]*)</g)) {
        const t = m[1];
        if (t && !t.includes("{") && !t.includes("$") && !t.includes("L(")) add(t, p);
      }
      // 2. Props with string literal, not wrapped in L().
      for (const m of src.matchAll(
        /\b(title|placeholder|aria-label|alt|label|description|text|message|emptyText|tooltip|heading|subtitle|confirmText|cancelText|okText|errorText|successText|loadingText)\s*=\s*"([^"]{2,})"/g,
      )) {
        add(m[2], p, `(prop:${m[1]})`);
      }
      // 3. String literals in toast/dialog-ish calls.
      for (const m of src.matchAll(/\b(toast|showToast|setError|setStatus)\s*\(\s*"([^"]{3,})"/g)) {
        add(m[2], p, `(${m[1]})`);
      }
    }
  }
}
walk("src");

const sorted = [...candidates.entries()].sort((a, b) => b[1].size - a[1].size);
console.log("剩余英文候选:", sorted.length);
for (const [k, v] of sorted.slice(0, 80)) {
  console.log("  " + JSON.stringify(k) + "  <- " + [...v].slice(0, 2).join(", "));
}
