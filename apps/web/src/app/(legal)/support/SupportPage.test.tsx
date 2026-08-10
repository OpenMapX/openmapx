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

  it.each([["/privacy"], ["/terms"], ["/licenses"], ["/delete-account"]])(
    "links to %s",
    async (href) => {
      const view = await renderPage();

      expect(view.container.querySelector(`a[href="${href}"]`)).toBeTruthy();
    },
  );

  it("explains why guidance stops when the screen locks", async () => {
    const view = await renderPage();

    // The single most confusing thing about the app, explained rather than
    // answered with "reinstall".
    expect(view.getByText(en.legal.supportNavigationStopsBody)).toBeInTheDocument();
  });

  it("is honest that a cold offline start cannot show the map", async () => {
    const view = await renderPage();

    expect(view.getByText(en.legal.supportOfflineBody)).toBeInTheDocument();
  });
});
