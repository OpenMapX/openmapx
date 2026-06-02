import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatDuration: (s: number) => `${s}s`,
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
        onToggleVoice={() => {}}
        onEnd={() => {}}
        units="metric"
      />,
    );
    expect(html).toContain("1200 m");
    expect(html).toContain("300s");
    expect(html).toContain("end"); // i18n key passthrough
  });
});
