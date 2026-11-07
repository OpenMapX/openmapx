import { en } from "@openmapx/i18n";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", async () => {
  const { en: catalogue } = await import("@openmapx/i18n");
  return {
    getTranslations: async (namespace: string) => (key: string) =>
      (catalogue as unknown as Record<string, Record<string, string>>)[namespace][key],
  };
});

const SupportPage = (await import("./page")).default;

afterEach(cleanup);

const renderPage = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      {await SupportPage()}
    </NextIntlClientProvider>,
  );

describe("SupportPage", () => {
  it("offers a way to reach a human", async () => {
    const view = await renderPage();

    // The stores require a support address that keeps working.
    expect(view.getByText("support@openmapx.com")).toBeInTheDocument();
  });

  it("links to legal and account pages", async () => {
    const view = await renderPage();
    for (const href of ["/privacy", "/terms", "/licenses", "/delete-account"]) {
      expect(view.container.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }
  });
});
