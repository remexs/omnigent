const fs = require("fs");
const path = require("path");

const dictSrc = fs.readFileSync("src/i18n/zh-CN.ts", "utf8");
const dictKeys = new Set(
  [...dictSrc.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")),
);

const missing = new Set();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p);
    } else if (/\.tsx$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/L\("((?:[^"\\]|\\.)*)"\)/g)) {
        const k = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (!dictKeys.has(k)) missing.add(k);
      }
    }
  }
}
walk("src");
console.log("未覆盖 key 数:", missing.size);
console.log([...missing].sort().join("\n"));
