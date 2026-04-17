import { describe, expect, it } from "vitest";
import { fixMojibakeString } from "../mobidrom-common.js";

describe("fixMojibakeString", () => {
  it("repairs ü mojibake", () => {
    expect(fixMojibakeString("Tannenbusch-SÃ¼d")).toBe("Tannenbusch-Süd");
  });

  it("repairs ß mojibake", () => {
    expect(fixMojibakeString("HauptstraÃŸe")).toBe("Hauptstraße");
  });

  it("repairs ö and ä mojibake", () => {
    expect(fixMojibakeString("K\u00c3\u00b6ln")).toBe("Köln");
    expect(fixMojibakeString("M\u00c3\u00bcnster")).toBe("Münster");
    expect(fixMojibakeString("D\u00c3\u00bcsseldorf-Derendorf")).toBe("Düsseldorf-Derendorf");
  });

  it("leaves plain ASCII unchanged", () => {
    expect(fixMojibakeString("Parkhaus Rathaus")).toBe("Parkhaus Rathaus");
  });

  it("leaves correctly-encoded UTF-8 strings unchanged", () => {
    expect(fixMojibakeString("Düsseldorf")).toBe("Düsseldorf");
    expect(fixMojibakeString("Köln-Mülheim")).toBe("Köln-Mülheim");
    expect(fixMojibakeString("Aachener Straße")).toBe("Aachener Straße");
  });

  it("does not alter strings that look like mojibake but round-trip to invalid UTF-8", () => {
    // "ÃZ" → 0xC3 0x5A is not a valid UTF-8 continuation; the round-trip
    // throws and we fall back to the original.
    expect(fixMojibakeString("ÃZ")).toBe("ÃZ");
    // Legitimate German "Ächtung" starts with Ä (0xC4) — TextDecoder rejects
    // 0xC4 followed by 'c' (not a continuation byte).
    expect(fixMojibakeString("Ächtung")).toBe("Ächtung");
  });

  it("handles mixed content — fixes only the mojibake parts", () => {
    expect(fixMojibakeString("Parkhaus MÃ¼nster Hauptbahnhof")).toBe(
      "Parkhaus Münster Hauptbahnhof",
    );
  });

  it("leaves strings containing emoji unchanged (code points > 0xFF)", () => {
    const s = "Parkhaus 🚗 Hauptstraße";
    expect(fixMojibakeString(s)).toBe(s);
  });

  it("is idempotent on already-repaired text", () => {
    const once = fixMojibakeString("SÃ¼d");
    const twice = fixMojibakeString(once);
    expect(twice).toBe("Süd");
  });
});
