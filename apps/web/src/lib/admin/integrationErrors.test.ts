import { ApiClientError } from "@openmapx/core";
import { expect, it } from "vitest";
import { integrationErrorMessage } from "./integrationErrors";

it("describes a preflight refusal without claiming the imported rows were saved", () => {
  const message = integrationErrorMessage(
    new ApiClientError(
      409,
      {
        ok: false,
        error: "Integration import failed",
        phase: "persistence",
        recovery: "reconciliation_required",
        database: "retained",
        runtime: "unchanged",
      },
      null,
    ),
    "Import failed",
  );
  expect(message).toContain("The saved configuration is unchanged.");
  expect(message).not.toContain("The imported configuration is saved.");
});
it("retains the desired-versus-runtime distinction after a committed import fails reload", () => {
  const message = integrationErrorMessage(
    new ApiClientError(
      409,
      {
        ok: false,
        error: "Integration import failed",
        phase: "reload",
        recovery: "reconciliation_required",
        database: "retained",
        runtime: "unknown",
      },
      null,
    ),
    "Import failed",
  );
  expect(message).toContain("The imported configuration is saved.");
  expect(message).toContain("The running configuration is uncertain.");
});
