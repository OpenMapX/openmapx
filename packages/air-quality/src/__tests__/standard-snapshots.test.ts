import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import india from "../data/standards/cpcb-naqi-2014.json";
import canada from "../data/standards/eccc-aqhi-2026-08-29.json";
import eea from "../data/standards/eea-eaqi-2026-08-29.json";
import us from "../data/standards/epa-aqi-tad-2024-05.json";
import china from "../data/standards/hj633-2026.json";
import uk from "../data/standards/uk-daqi-2026-04-13.json";
import { registerBuiltinStandardAdapters } from "../standards/builtins";
import {
  clearStandardRegistryForTests,
  listStandardAdapters,
  resolveStandard,
} from "../standards/registry";

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  throw new TypeError("Snapshot transcription must be JSON-compatible");
}

describe("standard snapshots", () => {
  it.each([us, eea, uk, india, china, canada])(
    "pins the canonical transcription for $resolvedRevision",
    (snapshot) => {
      const actual = createHash("sha256").update(canonical(snapshot.transcription)).digest("hex");
      expect(snapshot.transcriptionChecksum).toBe(`sha256:${actual}`);
      expect(snapshot.transcriptionChecksum).not.toContain("0000000000000000");
    },
  );

  it("registers every built-in exactly once and resolves the current revisions", () => {
    clearStandardRegistryForTests();
    registerBuiltinStandardAdapters();
    registerBuiltinStandardAdapters();
    expect(listStandardAdapters()).toHaveLength(6);
    expect(resolveStandard("cn-hj633-2026", "2026-08-30T00:00:00Z")).toMatchObject({
      ok: true,
      resolvedRevision: "hj633-2026",
    });
    clearStandardRegistryForTests();
  });
});
