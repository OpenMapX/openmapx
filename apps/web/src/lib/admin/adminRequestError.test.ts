import { ApiClientError, ApiRequestAbortedError } from "@openmapx/core";
import { expect, it } from "vitest";
import { AdminRequestError, adminErrorText } from "./adminRequestError";

it("shows the server's message and words everything else with the caller's fallback", () => {
  expect(adminErrorText(new AdminRequestError("Reload denied"), "Fehlgeschlagen")).toBe(
    "Reload denied",
  );
  expect(adminErrorText(new AdminRequestError(null), "Fehlgeschlagen")).toBe("Fehlgeschlagen");
  expect(adminErrorText(new AdminRequestError(null, { unconfirmed: true }), "Unbestätigt")).toBe(
    "Unbestätigt",
  );
  expect(adminErrorText(new ApiClientError(500, null, null), "Fehlgeschlagen")).toBe(
    "Fehlgeschlagen",
  );
  expect(adminErrorText(new ApiClientError(409, { error: "Changed" }, null), "x")).toBe("Changed");
  expect(adminErrorText(new ApiRequestAbortedError("timeout"), "Zeitüberschreitung")).toBe(
    "Zeitüberschreitung",
  );
  expect(adminErrorText(new Error("Bereits übersetzt"), "x")).toBe("Bereits übersetzt");
  expect(adminErrorText("not an error", "Fehlgeschlagen")).toBe("Fehlgeschlagen");
});

it("keeps the server's message out of serialized errors", () => {
  expect(JSON.stringify(new AdminRequestError("private detail"))).not.toContain("private detail");
});
