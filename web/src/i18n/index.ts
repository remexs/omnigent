/**
 * Minimal i18n engine for the Omnigent web UI.
 *
 * Design goal: keep upstream sync cheap. The translation key IS the English
 * source string, so components only wrap literals with `L(...)` — no key
 * renames, no structural changes. When an upstream change alters an English
 * string, the lookup simply falls back to the English text until the
 * dictionary is updated, so a stale translation can never break the UI.
 *
 * Language selection (first match wins):
 *   1. `omnigent:language` in localStorage (set by the Settings UI)
 *   2. `navigator.language` starting with "zh"
 *   3. default: English
 */

import { zhCN } from "./zh-CN";

export type Language = "zh-CN" | "en";

export const LANGUAGE_STORAGE_KEY = "omnigent:language";

const dictionaries: Record<Language, Record<string, string>> = {
  "zh-CN": zhCN,
  en: {},
};

export function getLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") {
      return saved;
    }
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh")) {
      return "zh-CN";
    }
  } catch {
    // localStorage can throw in restricted contexts; fall through.
  }
  return "en";
}

/** Switch the UI language and reload so every component re-renders with the new strings. */
export function setLanguage(lang: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Ignore storage failures; the reload below still uses the default.
  }
  window.location.reload();
}

/**
 * Translate a UI string. When `params` are given, `{name}` placeholders in
 * both the translation and the English fallback are substituted.
 */
export function L(text: string, params?: Record<string, string | number>): string {
  const lang = getLanguage();
  let out = lang === "zh-CN" ? (dictionaries[lang][text] ?? text) : text;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
}

/** The HTML `lang` attribute for the current language. */
export function htmlLang(): string {
  return getLanguage() === "zh-CN" ? "zh-CN" : "en";
}
