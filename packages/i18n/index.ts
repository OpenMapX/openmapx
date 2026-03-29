export { default as de } from "./locales/de.json";
export { default as en } from "./locales/en.json";

export const locales = ["en", "de"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
