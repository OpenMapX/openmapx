import { mkdirSync, writeFileSync } from "node:fs";
import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { useNavigationStore } from "@openmapx/core";
import { captureTransitLegStops } from "@openmapx/core/navigation";
import type { TripItinerary, TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";
import messages from "../../../../../packages/i18n/locales/en.json";
import { TransitJourneySheet } from "./TransitJourneySheet";
import { TransitLegBanner } from "./TransitLegBanner";

vi.mock("@/lib/mobile/useMobileRuntime", () => ({
  useMobileRuntime: () => ({ browserAuthority: true }),
}));
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => vi.fn() }));
vi.mock("@/lib/navigation/navNotify", () => ({ notifyGetOff: vi.fn(), playAlarmTone: vi.fn() }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-11-06T20:48:00Z") }));
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string) =>
      new Date(v).toLocaleTimeString("en-GB", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
      }),
  }),
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<object>()),
  useVehicleJourney: () => ({ data: undefined, isError: false, isFetching: false }),
  useStopTransfers: () => ({ data: undefined }),
}));
const names = [
  "Aachen Hbf",
  "Aachen-Rothe Erde",
  "Stolberg (Rheinl) Hbf",
  "Eschweiler Hbf",
  "Langerwehe",
  "Düren",
  "Horrem",
  "Köln-Ehrenfeld",
  "Köln Hbf",
];
const codes = ["2", "2", "2", "3", "1", "3", "3", "3", "5 A-C"];
const times = ["20:51", "20:54", "21:01", "21:04", "21:10", "21:17", "21:28", "21:37", "21:49"];
const base: VehicleJourneyStop[] = names.map((name, i) => ({
  stopId: `s${i}`,
  name,
  lat: 50 + i / 100,
  lng: 6 + i / 100,
  scheduledDeparture: `2026-11-06T${times[i]}:00Z`,
  scheduledArrival: `2026-11-06T${times[i]}:00Z`,
  platform: i === 6 ? "37" : i === 7 ? "78" : undefined,
  scheduledPlatform: i === 6 ? "37" : i === 7 ? "78" : undefined,
}));
const leg: TripLeg = {
  tripId: "re1",
  geometry: {
    type: "LineString",
    coordinates: [
      [6, 50],
      [6.08, 50.08],
    ],
  },
  mode: "rail",
  startTime: "2026-11-06T20:51:00Z",
  endTime: "2026-11-06T21:49:00Z",
  from: { ...base[0] },
  to: { ...base[8] },
  route: { shortName: "RE1", longName: "", color: "E40000", textColor: "FFFFFF" },
  headsign: "Hamm (Westf) Hbf",
  tripShortName: "026839",
  operatorName: "National Express",
};
const itinerary: TripItinerary = {
  legs: [leg],
  duration: 3480,
  startTime: leg.startTime,
  endTime: leg.endTime,
  transfers: 0,
  walkDistance: 0,
  source: "transitous",
};
it("renders comparable RE1 platform states from the production banner and journey sheet", () => {
  for (const state of ["before", "after", "realtime"] as const) {
    const stops = structuredClone(base);
    if (state !== "before")
      stops.forEach((stop, i) => {
        stop.departurePlatform = {
          code: codes[i],
          kind: i === 6 || i === 7 ? "correction" : "schedule",
          sourceId: "delfi-siri-et-rhein-ruhr",
          recordedAt: "2026-11-06T18:30:58.165Z",
        };
        stop.platform = codes[i];
        stop.scheduledPlatform = codes[i];
      });
    if (state === "realtime")
      stops[0].departurePlatform = {
        code: "4 A-C",
        scheduledCode: "2",
        kind: "realtime",
        sourceId: "delfi-siri-et-rhein-ruhr",
      };
    useNavigationStore
      .getState()
      .setTransitCaptures(
        captureTransitLegStops([leg], { re1: stops }, Date.parse("2026-11-06T20:48:00Z")),
      );
    const view = render(
      <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
        <ThemeProvider theme={createTheme({ palette: { primary: { main: "#218022" } } })}>
          <CssBaseline />
          <main style={{ maxWidth: 440, margin: "auto", padding: 16 }}>
            <TransitLegBanner leg={leg} legIndex={0} transitProgress={null} />
            <div style={{ height: 24 }} />
            <TransitJourneySheet
              itinerary={itinerary}
              currentLegIndex={0}
              transitProgress={null}
              scroll={false}
            />
          </main>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    if (state === "before") expect(view.container.textContent).toContain("Pl. 37");
    else if (state === "after") {
      expect(view.container.textContent).not.toContain("Pl. 37");
      expect(view.container.textContent).toContain("5 A-C");
      expect(view.container.textContent).not.toContain("(changed)");
    } else expect(view.container.textContent).toContain("2 → 4 A-C");
    if (process.env.PLATFORM_VISUAL_DIR) {
      const css = Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText))
        .join("\n");
      mkdirSync(process.env.PLATFORM_VISUAL_DIR, { recursive: true });
      writeFileSync(
        `${process.env.PLATFORM_VISUAL_DIR}/${state}.html`,
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${view.container.innerHTML}</body></html>`,
      );
    }
    cleanup();
  }
});
