import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatDuration: (s: number) => `${s}s`,
  formatMeasurementDistance: (m: number, sys: string) =>
    sys === "imperial" ? `${m} ft` : `${m} m`,
}));
vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
  }),
}));

import { NavBottomBar } from "./NavBottomBar";

describe("NavBottomBar", () => {
  it("renders remaining distance, duration, and an end button", () => {
    const html = renderToStaticMarkup(
      <NavBottomBar
        distanceRemaining={1200}
        durationRemaining={300}
        etaEpochMs={0}
        voiceEnabled
        keepScreenOn
        onToggleVoice={() => {}}
        onToggleKeepScreenOn={() => {}}
        onOverview={() => {}}
        onEnd={() => {}}
        units="metric"
      />,
    );
    expect(html).toContain("1200 m");
    expect(html).toContain("300s");
    expect(html).toContain("end"); // i18n key passthrough
  });

  it("exposes a more-options menu trigger", () => {
    const html = renderToStaticMarkup(
      <NavBottomBar
        distanceRemaining={1200}
        durationRemaining={300}
        etaEpochMs={0}
        voiceEnabled
        keepScreenOn
        onToggleVoice={() => {}}
        onToggleKeepScreenOn={() => {}}
        onOverview={() => {}}
        onEnd={() => {}}
        units="metric"
      />,
    );
    expect(html).toContain("moreOptions"); // overflow trigger aria-label
  });
});
