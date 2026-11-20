import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { formatCalendarDate, formatClockTime, formatDateAndTime } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import type { DateTimeFormatters } from "@/integration-api/runtime/useDateTimeFormat";
import { adminFormatters } from "./adminFormat";

function dates(locale: string): DateTimeFormatters {
  const options = { locale, timeFormat: "24h", dateFormat: "auto", timeZone: "UTC" } as const;
  return {
    time: (value) => formatClockTime(value, options),
    date: (value) => formatCalendarDate(value, options),
    dateTime: (value) => formatDateAndTime(value, options),
    relative: () => "",
    recent: () => "",
  };
}

describe("admin formatters", () => {
  const en = adminFormatters("en", dates("en"));
  const de = adminFormatters("de", dates("de"));

  it("group numbers and write sizes with the reader's separators", () => {
    expect(en.number(12345)).toBe("12,345");
    expect(de.number(12345)).toBe("12.345");
    expect(en.bytes(187_695_104)).toBe("179.0 MB");
    expect(de.bytes(187_695_104)).toBe("179,0 MB");
    expect(de.bytes(0)).toBe("0 B");
  });

  it("space percentages as the locale does", () => {
    expect(en.percent(0.95)).toBe("95%");
    expect(de.percent(0.95)).toBe("95 %");
  });

  it("word durations in the locale's units", () => {
    expect(en.duration(850)).toMatch(/^850\sms$/);
    expect(de.duration(1500)).toMatch(/^1,5\sSek\.$/);
    expect(en.duration(125_000)).toMatch(/^2\smin 5\ssec$/);
  });

  it("show a dash for a missing or unreadable timestamp", () => {
    expect(en.timestamp(null)).toBe("—");
    expect(en.timestamp("not a date")).toBe("—");
    expect(de.timestamp("2026-11-18T17:02:00Z")).toContain("17:02");
  });
});

/**
 * The browser's language is not the reader's chosen locale. Admin code formats
 * through `adminFormatters`; these shapes format with whatever the browser has.
 */
const LOCALE_FREE_FORMATTING: [RegExp, string][] = [
  [/\.toFixed\(/, "toFixed ignores the locale; use the admin formatters"],
  [
    /\.toLocale(?:String|DateString|TimeString)\(\s*(?:\)|undefined\b)/,
    "toLocale…() without a locale uses the browser's language; use the admin formatters",
  ],
  [/new Intl\.\w+\(\s*(?:\)|undefined\b)/, "Intl without a locale uses the browser's language"],
  [/\.toLocale\w*\(\s*["'`]/, "a fixed locale ignores the reader's choice"],
  [/\$\{[^}]+\}(?:ms|s|m|%)\b/, "a unit glued to a number by hand; use the admin formatters"],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.test-support\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("admin source", () => {
  const root = join(__dirname, "../..");
  const trees = ["components/admin", "app/admin", "lib/admin"].map((tree) => join(root, tree));

  it("formats numbers, sizes and dates only in the reader's locale", () => {
    const found = trees.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          LOCALE_FREE_FORMATTING.filter(([pattern]) => pattern.test(line)).map(
            ([, why]) => `${relative(root, file)}:${index + 1}: ${why}`,
          ),
        ),
    );
    expect(found).toEqual([]);
  });
});
