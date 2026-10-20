import opening_hours from "opening_hours";
import { describe, expect, it } from "vitest";
import {
  buildSimpleWeekdaySelectors,
  createDefaultOpeningHoursRule,
  extractSimpleWeekdaySelection,
  parseOsmOpeningHours,
  serializeOsmOpeningHours,
} from "../osmOpeningHoursAst";

const SYNTAX_NOMINATIM = {
  lat: 48.137,
  lon: 11.576,
  address: { country_code: "de", state: "Bayern" },
};

describe("osmOpeningHoursAst", () => {
  describe("parseOsmOpeningHours & serializeOsmOpeningHours round-trip", () => {
    const validCases: Array<{ input: string; expectedCanonical?: string }> = [
      { input: "24/7" },
      { input: '24/7 open "Always open"' },
      { input: "Mo-Fr 09:00-17:00" },
      { input: "Mo-Fr 08:00-12:00,13:00-17:30; Sa 09:00-14:00; Su,PH off" },
      { input: "Mo-Fr 10:00-20:00 || Sa 10:00-14:00" },
      { input: "Mo-Fr 09:00-17:00, Sa 10:00-14:00" },
      { input: "Mo-Fr 08:00+" },
      { input: "Mo-Fr 08:00-18:00+" },
      { input: "Mo-Fr 22:00-02:00" },
      { input: "Mo-Fr 10:00-26:00" },
      { input: "Mo-Fr 08:00-16:00/30" },
      { input: "Mo-Fr 08:00-16:00/01:30" },
      { input: "Mo-Fr 10:00" },
      { input: "dawn-dusk" },
      { input: "sunrise-sunset" },
      { input: "(dawn-00:30)-(dusk+01:00)" },
      { input: "Mo-Fr (sunrise+01:00)-(sunset-00:30)" },
      { input: "Mo[1,3,-1] 09:00-17:00" },
      { input: "Fr[1-3] +1 day 09:00-17:00" },
      { input: "Su[-1] -2 days 10:00-14:00" },
      { input: "PH -1 day 09:00-13:00; PH off" },
      { input: "SH Mo-Fr 08:00-12:00" },
      { input: "Mo-Fr,SH 08:00-12:00" },
      {
        input:
          '2025-2028/2 Jan-Mar week 01-53/2: SH Fr[1,3,-1] +1 day (sunrise+01:00)-(sunset-00:30)+ open "seasonal"',
      },
      { input: "2025+ Apr-Oct: Mo-Su 09:00-21:00" },
      { input: "2025/2 Mo-Fr 09:00-17:00" },
      { input: "Jan 15-Feb 20 08:00-16:00" },
      { input: "May 01-10 10:00-18:00" },
      { input: "2025 May 01-2025 May 10 10:00-12:00" },
      { input: "May Su[1] +2 days 10:00+" },
      { input: "May Su[-1] -1 day 10:00-12:00" },
      { input: "easter -2 days-easter +1 day: 10:00-18:00" },
      { input: "2026 easter +1 day 10:00-16:00" },
      { input: "week 02-52/2 Fr 09:00-14:00" },
      { input: '"By appointment": Mo-Fr 09:00-17:00' },
      { input: 'Mo-Fr 09:00-17:00 unknown "check website"' },
      { input: 'closed "renovation until summer"' },
      { input: 'open "admission free"' },
      { input: "Mo-Fr" },
      { input: "Jan-Mar" },
      {
        input: "mo-fr 9:00-17:00 ; sa 10:00-14:00",
        expectedCanonical: "Mo-Fr 09:00-17:00; Sa 10:00-14:00",
      },
      {
        input: "May 01 - May 10 10:00-12:00",
        expectedCanonical: "May 01-10 10:00-12:00",
      },
    ];

    for (const { input, expectedCanonical } of validCases) {
      it(`parses, serializes, and validates "${input}"`, () => {
        const result = parseOsmOpeningHours(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const target = expectedCanonical ?? input;
        expect(result.canonical).toBe(target);

        // Re-parsing the canonical output must produce an identical AST and string
        const reparsed = parseOsmOpeningHours(result.canonical);
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(reparsed.canonical).toBe(result.canonical);
        expect(reparsed.document).toEqual(result.document);

        // Server-side `opening_hours` library must accept the canonical string
        expect(() => new opening_hours(result.canonical, SYNTAX_NOMINATIM, 2)).not.toThrow();
      });
    }
  });

  describe("invalid syntax rejection", () => {
    const invalidCases = [
      "",
      "   ",
      "every tuesday maybe",
      "Mo-Fr 09:00-17:00;",
      "Mo-Fr 25:00-26:00",
      "Mo-Fr 09:00-49:00",
      "Mo-Fr 09:60-17:00",
      "Mo-Fr 09:0-17:00",
      "Mo-Fr[1] 09:00-17:00",
      "Mo[0] 09:00-17:00",
      "Mo[6] 09:00-17:00",
      "Jan 32 09:00-17:00",
      "week 54 Mo 09:00-17:00",
      'Mo-Fr 09:00-17:00 "unterminated',
      "(sunrise+01:00",
    ];

    for (const input of invalidCases) {
      it(`rejects invalid input: "${input}"`, () => {
        const result = parseOsmOpeningHours(input);
        expect(result.ok).toBe(false);
      });
    }
  });

  describe("simple weekday extraction and compaction", () => {
    it("extracts and compacts consecutive weekday ranges and holidays", () => {
      const items = buildSimpleWeekdaySelectors({
        weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Su"],
        includePH: true,
        includeSH: false,
        shAndMode: false,
      });

      const doc = {
        rules: [
          {
            ...createDefaultOpeningHoursRule(),
            weekdays: items,
          },
        ],
      };

      expect(serializeOsmOpeningHours(doc)).toBe("Mo-Fr,Su,PH 09:00-17:00");

      const extracted = extractSimpleWeekdaySelection(items);
      expect(extracted).toEqual({
        weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Su"],
        includePH: true,
        includeSH: false,
        shAndMode: false,
      });
    });

    it("handles SH in AND mode (SH Mo-Fr)", () => {
      const items = buildSimpleWeekdaySelectors({
        weekdays: ["Mo", "Tu", "We", "Th", "Fr"],
        includePH: false,
        includeSH: true,
        shAndMode: true,
      });

      const doc = {
        rules: [
          {
            ...createDefaultOpeningHoursRule(),
            weekdays: items,
          },
        ],
      };

      expect(serializeOsmOpeningHours(doc)).toBe("SH Mo-Fr 09:00-17:00");
      expect(extractSimpleWeekdaySelection(items)).toEqual({
        weekdays: ["Mo", "Tu", "We", "Th", "Fr"],
        includePH: false,
        includeSH: true,
        shAndMode: true,
      });
    });

    it("returns null from extractSimpleWeekdaySelection when nth or day offsets are present", () => {
      const parsed = parseOsmOpeningHours("Mo[1,3] +1 day 09:00-17:00");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(extractSimpleWeekdaySelection(parsed.document.rules[0]?.weekdays ?? [])).toBeNull();
    });
  });
});
