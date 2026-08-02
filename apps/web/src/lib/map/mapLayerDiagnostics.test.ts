import { afterEach, describe, expect, it } from "vitest";
import { type CapturedConsoleErrors, captureConsoleErrors } from "@/test";
import { clearGroupError, reportGroupError, reportMissingLayers } from "./mapLayerDiagnostics";

let errors: CapturedConsoleErrors | null = null;

afterEach(() => {
  errors?.restore();
  errors = null;
  // Leave no dedup state behind for the next test.
  reportMissingLayers([]);
  clearGroupError("a");
});

describe("reportMissingLayers", () => {
  it("reports a missing layer once, not once per idle frame", () => {
    errors = captureConsoleErrors();
    const missing = [{ key: "a", missing: ["layer:l"] }];
    reportMissingLayers(missing);
    reportMissingLayers(missing);
    reportMissingLayers(missing);
    expect(errors.count).toBe(1);
  });

  it("reports again after the layer came back and went missing a second time", () => {
    errors = captureConsoleErrors();
    reportMissingLayers([{ key: "a", missing: ["layer:l"] }]);
    // The layer recovered. This is the call that has to happen for the dedup set
    // to clear — reporting only when something is missing would swallow the next
    // disappearance entirely.
    reportMissingLayers([]);
    reportMissingLayers([{ key: "a", missing: ["layer:l"] }]);
    expect(errors.count).toBe(2);
  });
});

describe("reportGroupError", () => {
  it("reports one message once and a changed message again", () => {
    errors = captureConsoleErrors();
    reportGroupError("a", new Error("first"));
    reportGroupError("a", new Error("first"));
    expect(errors.count).toBe(1);
    reportGroupError("a", new Error("second"));
    expect(errors.count).toBe(2);
  });

  it("reports a fault that returns after a clean apply", () => {
    errors = captureConsoleErrors();
    reportGroupError("a", new Error("same"));
    clearGroupError("a");
    reportGroupError("a", new Error("same"));
    expect(errors.count).toBe(2);
  });
});
