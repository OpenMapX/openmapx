// Validation-only CodeQL probe for temporary branches. Never import, invoke, or merge this file.
// This uncalled function exists only for hosted static analysis; no request is executed.
import { readFileSync } from "node:fs";

// Intended Medium probe: js/file-access-to-http. Read only a fixed, non-secret test fixture.
export async function sendLocalValidationFixture() {
  const body = readFileSync(
    "services/data-manager/__tests__/transitous/fixtures/tiny-gtfs/ch_demo/agency.txt",
    "utf8",
  );
  return globalThis.fetch("https://codeql-validation.invalid", { method: "POST", body });
}
