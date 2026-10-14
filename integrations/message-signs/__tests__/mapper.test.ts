import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  sharedStrings,
} from "@openmapx/integration-framework/strings";
import type { MessageSign } from "@openmapx/mobility-core/message-sign";
import { describe, expect, it } from "vitest";
import { mapSignToDetail, mapSignToResult, variantOf } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const AT = "2026-10-08T06:30:00Z";

function text(t: unknown, locale = "en"): string {
  if (!isI18nToken(t)) return String(t);
  return resolveToken(t, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: { en, de },
  });
}

function sign(over: Partial<MessageSign> = {}): MessageSign {
  return {
    id: "oc:feature:us-ny-511-signs:nySigns:Region_9:_8090",
    name: "I81 NB VMS 8 JOHNSON RD",
    type: "matrix",
    coordinates: [-75.800052, 42.071745],
    location: "I-81 N at MP 6.0",
    road: "I-81",
    direction: "N",
    operator: { name: "NY Signs - Region 9" },
    status: "in_service",
    pages: [
      ["CRASH AHEAD", "EXIT 7"],
      ["RIGHT LANE", "CLOSED"],
    ],
    updatedAt: AT,
    sources: ["us-ny-511-signs"],
    attributions: [{ sourceId: "us-ny-511-signs", name: "511NY / New York State DOT" }],
    ...over,
  };
}

describe("mapSignToResult", () => {
  it("shows a sign with a message in the showing colour, its pages as one line", () => {
    const result = mapSignToResult(sign());
    expect(result).toMatchObject({
      id: "oc:feature:us-ny-511-signs:nySigns:Region_9:_8090",
      source: "us-ny-511-signs",
      variant: "showing",
      status: "operational",
      operator: "NY Signs - Region 9",
      observedAt: AT,
    });
    expect(text(result.summary)).toBe("Shows: CRASH AHEAD EXIT 7 / RIGHT LANE CLOSED");
    expect(text(result.summary, "de")).toBe("Zeigt: CRASH AHEAD EXIT 7 / RIGHT LANE CLOSED");
  });

  it("dims a blank or failed sign", () => {
    const blank = mapSignToResult(sign({ status: "blank", pages: [] }));
    expect(blank).toMatchObject({ variant: "blank", status: "non-operational" });
    expect(text(blank.summary)).toBe("Blank");
    const failed = mapSignToResult(sign({ status: "fault", pages: [] }));
    expect(failed).toMatchObject({ variant: "fault", status: "non-operational" });
    expect(text(failed.summary, "de")).toBe("Außer Betrieb");
  });

  it("states nothing it does not know", () => {
    const unknown = mapSignToResult(sign({ status: "unknown", pages: [], updatedAt: undefined }));
    expect(unknown).toMatchObject({ variant: "unknown", status: "unknown" });
    expect(unknown.observedAt).toBeUndefined();
    expect(variantOf(sign({ status: "in_service", pages: [] }))).toBe("unknown");
  });

  it("names a sign its sources leave unnamed", () => {
    expect(text(mapSignToResult(sign({ name: "" })).fallbackName)).toBe("Message sign");
  });
});

describe("mapSignToDetail", () => {
  it("shows each page with its numbered lines, the first with when it was shown", () => {
    const detail = mapSignToDetail(sign());
    const [first, second, info] = detail.sections;
    expect(text(first!.title)).toBe("Page 1 of 2");
    expect(first!.rows?.map(([label, line]) => [text(label), line])).toEqual([
      ["Line 1", "CRASH AHEAD"],
      ["Line 2", "EXIT 7"],
    ]);
    expect(text(first!.caption)).toBe("Shown since");
    expect(first!.captionTimestamp).toBe(AT);
    expect(text(second!.title, "de")).toBe("Seite 2 von 2");
    expect(second!.caption).toBeUndefined();
    expect(info!.rows?.map(([label, value]) => [text(label), text(value)])).toEqual([
      ["Road", "I-81"],
      ["Facing traffic", "Northbound"],
      ["Location", "I-81 N at MP 6.0"],
      ["Provider", "NY Signs - Region 9"],
    ]);
    expect(detail.operator).toEqual({ name: "NY Signs - Region 9" });
  });

  it("titles a one-page message as the message", () => {
    const detail = mapSignToDetail(sign({ pages: [["SLOW DOWN"]] }));
    expect(detail.sections.map((s) => text(s.title))).toEqual(["Message", "Info"]);
  });

  it("says what a sign without a message is doing", () => {
    const blank = mapSignToDetail(sign({ status: "blank", pages: [] }));
    expect(blank.sections[0]).toMatchObject({ type: "text", captionTimestamp: AT });
    expect(text(blank.sections[0]!.content)).toBe("The sign is blank.");
    const failed = mapSignToDetail(sign({ status: "fault", pages: [], updatedAt: undefined }));
    expect(text(failed.sections[0]!.content, "de")).toBe("Die Tafel ist außer Betrieb.");
    expect(failed.sections[0]!.caption).toBeUndefined();
  });
});

/** Every token in `value`, nested ones included. */
function tokensIn(value: unknown, into: I18nToken[] = []): I18nToken[] {
  if (Array.isArray(value)) {
    for (const item of value) tokensIn(item, into);
  } else if (isI18nToken(value)) {
    into.push(value);
    for (const v of Object.values(value.values ?? {})) tokensIn(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) tokensIn(v, into);
  }
  return into;
}

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

/** Every leaf key of a catalogue, dotted. */
function leafKeys(catalog: unknown, prefix = ""): string[] {
  if (catalog === null || typeof catalog !== "object") return [prefix];
  return Object.entries(catalog).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe("message-signs strings", () => {
  const states = ["in_service", "blank", "fault", "unknown"] as const;
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const signs = [
    sign({ name: "" }),
    sign({ pages: [["ONE PAGE"]] }),
    ...states.map((status) => sign({ status, pages: status === "in_service" ? [["X"]] : [] })),
    ...directions.map((direction) => sign({ direction })),
  ];
  const emitted = tokensIn([signs.map(mapSignToResult), signs.map(mapSignToDetail)]);

  it("every token the mapper emits exists in en and de", () => {
    const own = emitted.filter((t) => !t.$t.startsWith("shared."));
    expect(own.length).toBeGreaterThan(0);
    for (const t of own) {
      expect(lookup(en, t.$t), `en ${t.$t}`).toBeTypeOf("string");
      expect(lookup(de, t.$t), `de ${t.$t}`).toBeTypeOf("string");
    }
  });

  it("the catalogue holds only the tokens the mapper emits, in both languages", () => {
    const used = new Set(emitted.map((t) => t.$t));
    const listing = new Set(["name", "description"]);
    expect(leafKeys(en).filter((k) => !listing.has(k) && !used.has(k))).toEqual([]);
    expect(leafKeys(de).sort()).toEqual(leafKeys(en).sort());
  });
});
