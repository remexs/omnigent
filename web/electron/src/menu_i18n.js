// Minimal menu i18n for the Electron shell's native menus.
//
// The web UI (React SPA) has its own translation layer; the native menus live
// in the main process and can't import it, so this tiny module mirrors the
// same "key = English source string" convention with a small local dictionary.
//
// Language resolution (first match wins):
//   1. settings.json `language` (set from the web UI via nativeBridge, when
//      wired up)
//   2. `app.getLocale()` starting with "zh"
//   3. default: English

"use strict";

const { app } = require("electron");

// Native menu strings. Keys are the English labels exactly as they appear in
// main.js; missing keys fall back to English so an upstream label change can
// never break the menu build.
const zhCN = {
  "New Window": "新建窗口",
  "New Window on Different Server…": "在其他服务器新建窗口…",
  "Change Server…": "切换服务器…",
  "Check for Updates…": "检查更新…",
  "Restart to Update": "重启以更新",
  "Close Window": "关闭窗口",
  Server: "服务器",
  Edit: "编辑",
  "Find…": "查找…",
  View: "视图",
  "Play Notification Sound": "播放通知提示音",
  Sound: "声音",
  Debug: "调试",
  "Add to Dictionary": "添加到词典",
  "Copy Link Address": "复制链接地址",
  "You're up to date!": "您已是最新版本！",
  "is the latest version.": "是最新版本。",
  "Couldn't check for updates": "无法检查更新",
  "No update is ready to install": "没有可安装的更新",
  "Check for updates first, then download the new version.": "请先检查更新，然后下载新版本。",
};

const english = {};

const dictionaries = { "zh-CN": zhCN, en: english };

function resolvedLanguage() {
  try {
    const settings = JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(app.getPath("userData"), "settings.json"),
        "utf8",
      ),
    );
    if (settings.language === "zh-CN" || settings.language === "en") {
      return settings.language;
    }
  } catch {
    // Missing/corrupt settings → fall through to locale detection.
  }
  const loc = (app.getLocale() || "").toLowerCase();
  return loc.startsWith("zh") ? "zh-CN" : "en";
}

/** Translate a native menu label; falls back to English for unknown keys. */
function menuLabel(text) {
  const dict = dictionaries[resolvedLanguage()] ?? english;
  return dict[text] ?? text;
}

module.exports = { menuLabel, resolvedLanguage };
