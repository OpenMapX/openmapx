import { expect, it } from "vitest";
import { dataExecutionInputFingerprint, validateDataExecutionPatch } from "./store.js";

it("uses normalized countries for execution identity", () => {
  expect(
    dataExecutionInputFingerprint({ kind: "transit-sync", countries: ["DE", "ch", "de"] }),
  ).toBe(dataExecutionInputFingerprint({ kind: "transit-sync", countries: ["ch", "de"] }));
  expect(dataExecutionInputFingerprint({ kind: "download-osm", region: "de" })).not.toBe(
    dataExecutionInputFingerprint({ kind: "download-osm", region: "ch" }),
  );
});
it("refuses identity fields at the checkpoint boundary", () => {
  expect(() => validateDataExecutionPatch({ deadlineAt: 123 })).toThrow();
  expect(() => validateDataExecutionPatch({ progress: 2 })).toThrow();
  expect(() =>
    validateDataExecutionPatch({
      diagnostics: { tail: [{ stream: "stderr", message: "x".repeat(4097) }], truncated: false },
    }),
  ).toThrow();
  expect(validateDataExecutionPatch({ progress: 0.5, publication: "not_started" })).toEqual({
    progress: 0.5,
    publication: "not_started",
  });
});
it("retains the explicitly unfiltered planet transit scope in normalized identity", () => {
  expect(() =>
    dataExecutionInputFingerprint({ kind: "transit-sync", countries: [] }),
  ).not.toThrow();
});
