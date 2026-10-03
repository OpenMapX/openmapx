import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import de from "../../../../../packages/i18n/locales/de.json";
import en from "../../../../../packages/i18n/locales/en.json";
import { SharedLinksSection } from "./SharedLinksSection";

vi.mock("@openmapx/core", () => ({
  useShares: () => ({
    data: [
      {
        id: "future",
        label: "Future",
        targetType: "list",
        mode: "live",
        createdAt: "2026-01-01T12:00:00Z",
        expiresAt: "2099-01-02T12:00:00Z",
      },
      {
        id: "never",
        label: "Never",
        targetType: "route",
        mode: "snapshot",
        createdAt: "2026-01-01T12:00:00Z",
        expiresAt: null,
      },
      {
        id: "past",
        label: "Past",
        targetType: "list",
        mode: "live",
        createdAt: "2026-01-01T12:00:00Z",
        expiresAt: "2020-01-01T12:00:00Z",
      },
    ],
  }),
  useRotateShare: () => ({ mutate: vi.fn() }),
  useRevokeShare: () => ({ mutate: vi.fn() }),
}));

describe("SharedLinksSection expiry", () => {
  it.each([
    ["en", en, "Expires", "Never", "Expired"],
    ["de", de, "Läuft ab", "Nie", "Abgelaufen"],
  ] as const)(
    "shows dated, non-expiring and expired links in %s",
    (locale, messages, expiry, never, expired) => {
      render(
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
          <SharedLinksSection />
        </NextIntlClientProvider>,
      );
      const future = screen.getByText("Future").parentElement?.parentElement;
      expect(future?.textContent).toContain(expiry);
      expect(future?.textContent).toContain("2099");
      expect(future?.textContent).not.toContain(expired);
      const permanent = screen.getByText("Never", { selector: "p" }).parentElement?.parentElement;
      expect(permanent?.textContent).toContain(`${expiry}: ${never}`);
      expect(screen.getByText("Past").parentElement?.parentElement?.textContent).toContain(expired);
    },
  );
});
