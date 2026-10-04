import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";
import de from "../../../../../../packages/i18n/locales/de.json";
import en from "../../../../../../packages/i18n/locales/en.json";
import { DataSourcePartialNotice } from "./DataSourcePartialNotice";

function renderIn(locale: "en" | "de", onZoomIn = vi.fn()) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      <DataSourcePartialNotice onZoomIn={onZoomIn} />
    </NextIntlClientProvider>,
  );
  return onZoomIn;
}

describe("DataSourcePartialNotice", () => {
  it("asks to zoom in to load more stations, and zooms in", () => {
    const onZoomIn = renderIn("en");
    expect(screen.getByRole("status").textContent).toContain("Zoom in to load more stations");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onZoomIn).toHaveBeenCalledTimes(1);
  });

  it("is translated", () => {
    renderIn("de");
    expect(screen.getByRole("status").textContent).toContain(
      "Für weitere Stationen näher heranzoomen",
    );
  });
});
