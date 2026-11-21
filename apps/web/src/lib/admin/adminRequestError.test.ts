import { ApiClientError, ApiRequestAbortedError } from "@openmapx/core";
import { ApiContractError } from "@openmapx/core/api-admin-sdk";
import { expect, it } from "vitest";
import { AdminDisplayError, AdminRequestError, adminErrorText } from "./adminRequestError";

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
  expect(adminErrorText(new AdminDisplayError("Bereits übersetzt"), "x")).toBe("Bereits übersetzt");
  expect(adminErrorText("not an error", "Fehlgeschlagen")).toBe("Fehlgeschlagen");
});

it("shows the fallback for English diagnostics that are not written for the reader", () => {
  expect(adminErrorText(new ApiContractError(200), "Fehlgeschlagen")).toBe("Fehlgeschlagen");
  expect(adminErrorText(new Error("Invalid service configuration"), "Ungültig")).toBe("Ungültig");
  expect(adminErrorText(new TypeError("Failed to fetch"), "Netzwerkfehler")).toBe("Netzwerkfehler");
});

it("keeps the server's message out of serialized errors", () => {
  expect(JSON.stringify(new AdminRequestError("private detail"))).not.toContain("private detail");
});
