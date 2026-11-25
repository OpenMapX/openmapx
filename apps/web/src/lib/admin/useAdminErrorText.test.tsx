import { ApiClientError } from "@openmapx/core";
import { de, en } from "@openmapx/i18n";
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { AdminRequestError } from "./adminRequestError";
import { missingServiceSettings, useAdminErrorText } from "./useAdminErrorText";

const refusal = new ApiClientError(
  409,
  {
    error: "Required service settings have no value: ingest (INSTANCE_ID, API_TOKEN).",
    code: "REQUIRED_SETTINGS_MISSING",
    missingSettings: [{ serviceId: "ingest", keys: ["INSTANCE_ID", "API_TOKEN"] }],
  },
  null,
);

function textIn(locale: "en" | "de") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      {children}
    </NextIntlClientProvider>
  );
  return renderHook(() => useAdminErrorText(), { wrapper }).result.current;
}

it("names the services and settings a refused apply lacks, in the reader's language", () => {
  // The service layer wraps the client error; the names are read through the cause.
  const wrapped = new AdminRequestError(refusal.message, { cause: refusal });
  expect(missingServiceSettings(wrapped)).toEqual([
    { serviceId: "ingest", keys: ["INSTANCE_ID", "API_TOKEN"] },
  ]);
  expect(textIn("en")(wrapped, "Save failed")).toBe(
    "Required settings have no value: ingest (INSTANCE_ID, API_TOKEN). Set them in the service's settings or credentials, then apply again.",
  );
  expect(textIn("de")(wrapped, "Speichern fehlgeschlagen")).toContain(
    "Erforderliche Einstellungen haben keinen Wert: ingest (INSTANCE_ID, API_TOKEN).",
  );
});

it("words every other failure as adminErrorText does", () => {
  const t = textIn("en");
  expect(t(new ApiClientError(409, { error: "Changed" }, null), "x")).toBe("Changed");
  expect(
    t(new ApiClientError(409, { error: "x", code: "REQUIRED_SETTINGS_MISSING" }, null), "Fallback"),
  ).toBe("x");
  expect(t(new Error("diagnostic"), "Fallback")).toBe("Fallback");
});
