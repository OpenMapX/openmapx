import type { DataSourcePartialReason } from "@openmapx/core";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";
import de from "../../../../../../packages/i18n/locales/de.json";
import en from "../../../../../../packages/i18n/locales/en.json";
import { DataSourcePartialNotice } from "./DataSourcePartialNotice";

function renderIn(locale: "en" | "de", reason: DataSourcePartialReason) {
  const onZoomIn = vi.fn();
  const onRetry = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      <DataSourcePartialNotice reason={reason} onZoomIn={onZoomIn} onRetry={onRetry} />
    </NextIntlClientProvider>,
  );
  return { onZoomIn, onRetry };
}

describe("DataSourcePartialNotice", () => {
  it("asks to zoom in to load more, naming no kind of place, and zooms in", () => {
    const { onZoomIn, onRetry } = renderIn("en", "area");
    expect(screen.getByRole("status").textContent).toContain("Zoom in to load more");
    expect(screen.getByRole("status").textContent).not.toContain("stations");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("says a source did not answer and offers to ask again, not to zoom in", () => {
    const { onZoomIn, onRetry } = renderIn("en", "unavailable");
    expect(screen.getByRole("status").textContent).toContain(
      "Not every source answered, so results may be missing here.",
    );
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onZoomIn).not.toHaveBeenCalled();
  });

  it("is translated", () => {
    renderIn("de", "area");
    expect(screen.getByRole("status").textContent).toContain(
      "Für mehr Ergebnisse näher heranzoomen",
    );
  });

  it("translates the unavailable notice", () => {
    renderIn("de", "unavailable");
    expect(screen.getByRole("status").textContent).toContain("Nicht jede Quelle hat geantwortet");
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy();
  });
});
