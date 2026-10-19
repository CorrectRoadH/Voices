// @concord-file
// @concord-implements docs/feature/interface-language/README.md
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "@/locales/zh-CN.json";
import en from "@/locales/en.json";

export type UILanguage = "zh-CN" | "en";
export function normalizeLanguage(value: unknown): UILanguage {
  return value === "en" ? "en" : "zh-CN";
}

export function guestLanguage(): UILanguage {
  try { return normalizeLanguage(localStorage.getItem("voices.guest-language")); }
  catch { return "zh-CN"; }
}

void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zh }, en: { translation: en } },
  lng: guestLanguage(),
  fallbackLng: "zh-CN",
  supportedLngs: ["zh-CN", "en"],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
});

// Call at render/event time. User content must never be passed as a resource key.
export function tr(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values);
}

export function interfaceLocale(): UILanguage {
  return normalizeLanguage(i18n.resolvedLanguage);
}

export function changeInterfaceLanguage(language: UILanguage) {
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

export function chooseGuestLanguage(language: UILanguage) {
  try { localStorage.setItem("voices.guest-language", language); } catch { /* Remain usable without storage. */ }
  changeInterfaceLanguage(language);
}

changeInterfaceLanguage(guestLanguage());

export default i18n;
