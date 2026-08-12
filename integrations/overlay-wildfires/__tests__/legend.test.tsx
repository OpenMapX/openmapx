import { useMapStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, userEvent, within } from "@/test";
import de from "../../../packages/i18n/locales/de.json";
import en from "../../../packages/i18n/locales/en.json";
import { useWildfireStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { WildfireLegend } from "../legend";

const SOURCE_IDS = ["firms", "nifc", "effis", "noaa-hms"] as const;

beforeEach(() => {
  useMapStore.setState({ zoom: 4 });
  useWildfireStore.setState({
    panelOpen: true,
    layerVisible: true,
    dayRange: 1,
    source: "VIIRS_SNPP_NRT",
    showHotspots: true,
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
    showNoaaSmoke: false,
    showHeatmap: false,
  });
  for (const sourceId of SOURCE_IDS) {
    useWildfireStore.getState().resetSourceStatus(sourceId);
  }
});

describe("WildfireLegend source controls", () => {
  it("renders four localized switches with NOAA as the only opt-in source", () => {
    render(<WildfireLegend />);

    expect(screen.getByRole("switch", { name: "wildfires.showHotspots" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "wildfires.showReportedPerimeters" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "wildfires.showSatelliteBurnedAreas" }),
    ).toBeChecked();
    expect(screen.getByRole("switch", { name: "wildfires.showObservedSmoke" })).not.toBeChecked();
  });

  it.each([
    ["wildfires.showHotspots", "showHotspots"],
    ["wildfires.showReportedPerimeters", "showNifcPerimeters"],
    ["wildfires.showSatelliteBurnedAreas", "showEffisBurnedAreas"],
    ["wildfires.showObservedSmoke", "showNoaaSmoke"],
  ] as const)("changes only %s when its switch is clicked", async (label, field) => {
    render(<WildfireLegend />);
    const before = useWildfireStore.getState();

    await userEvent.click(screen.getByRole("switch", { name: label }));

    const after = useWildfireStore.getState();
    for (const sourceField of [
      "showHotspots",
      "showNifcPerimeters",
      "showEffisBurnedAreas",
      "showNoaaSmoke",
    ] as const) {
      expect(after[sourceField]).toBe(
        sourceField === field ? !before[sourceField] : before[sourceField],
      );
    }
  });

  it("keeps age, sensor, heatmap, recency, and FRP controls inside Hotspots", () => {
    render(<WildfireLegend />);

    const hotspots = within(screen.getByTestId("wildfire-source-firms"));
    expect(hotspots.getByText("wildfires.hotspotAge")).toBeTruthy();
    expect(hotspots.getByText("wildfires.sensor")).toBeTruthy();
    expect(hotspots.getByRole("switch", { name: "wildfires.heatmap" })).toBeTruthy();
    expect(hotspots.getByText("wildfires.recencyScale")).toBeTruthy();
    expect(hotspots.getByText("wildfires.frpSize")).toBeTruthy();

    for (const sourceId of ["nifc", "effis", "noaa-hms"]) {
      const source = within(screen.getByTestId(`wildfire-source-${sourceId}`));
      expect(source.queryByText("wildfires.hotspotAge")).toBeNull();
      expect(source.queryByText("wildfires.sensor")).toBeNull();
      expect(source.queryByRole("switch", { name: "wildfires.heatmap" })).toBeNull();
      expect(source.queryByText("wildfires.recencyScale")).toBeNull();
      expect(source.queryByText("wildfires.frpSize")).toBeNull();
    }
  });

  it("hides Hotspot-only controls when Hotspots are disabled", async () => {
    render(<WildfireLegend />);

    await userEvent.click(screen.getByRole("switch", { name: "wildfires.showHotspots" }));

    const hotspots = within(screen.getByTestId("wildfire-source-firms"));
    expect(hotspots.queryByText("wildfires.hotspotAge")).toBeNull();
    expect(hotspots.queryByText("wildfires.sensor")).toBeNull();
    expect(hotspots.queryByRole("switch", { name: "wildfires.heatmap" })).toBeNull();
    expect(hotspots.queryByText("wildfires.recencyScale")).toBeNull();
    expect(hotspots.queryByText("wildfires.frpSize")).toBeNull();
  });
});

describe("WildfireLegend source semantics and status", () => {
  it("guides only viewport polygon sources below zoom 3", () => {
    useMapStore.setState({ zoom: 2 });
    render(<WildfireLegend />);

    expect(
      within(screen.getByTestId("wildfire-source-nifc")).getByText(
        "wildfires.zoomInToLoadPolygons",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("wildfire-source-effis")).getByText(
        "wildfires.zoomInToLoadPolygons",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("wildfire-source-firms")).queryByText(
        "wildfires.zoomInToLoadPolygons",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("wildfire-source-noaa-hms")).queryByText(
        "wildfires.zoomInToLoadPolygons",
      ),
    ).toBeNull();
  });

  it("shows independent loading, fresh, empty, and stale source cues", () => {
    useWildfireStore.setState({ showNoaaSmoke: true });
    useWildfireStore.getState().setSourceStatus("firms", { loading: true });
    useWildfireStore.getState().setSourceStatus("nifc", {
      fetchedAt: Date.UTC(2026, 7, 12, 12),
      featureCount: 4,
    });
    useWildfireStore.getState().setSourceStatus("effis", {
      fetchedAt: Date.UTC(2026, 7, 12, 12),
      featureCount: 0,
    });
    useWildfireStore.getState().setSourceStatus("noaa-hms", {
      fetchedAt: Date.UTC(2026, 7, 12, 12),
      featureCount: 2,
      stale: true,
    });
    render(<WildfireLegend />);

    expect(
      within(screen.getByTestId("wildfire-source-firms")).getByText("wildfires.loading"),
    ).toBeTruthy();
    const nifc = within(screen.getByTestId("wildfire-source-nifc"));
    expect(nifc.getByText("wildfires.featureCount")).toBeTruthy();
    expect(nifc.getByText("wildfires.updatedTime")).toBeTruthy();
    const effis = within(screen.getByTestId("wildfire-source-effis"));
    expect(effis.getByText("wildfires.noFeaturesInView")).toBeTruthy();
    expect(effis.getByText("wildfires.updatedTime")).toBeTruthy();
    const noaa = within(screen.getByTestId("wildfire-source-noaa-hms"));
    expect(noaa.getByText("wildfires.featureCount")).toBeTruthy();
    expect(noaa.getByText("wildfires.staleTime")).toBeTruthy();
  });

  it("keeps unavailable and truncated feedback on the affected source row", () => {
    useWildfireStore.getState().setSourceStatus("nifc", {
      fetchedAt: Date.UTC(2026, 7, 12, 12),
      featureCount: 7,
    });
    useWildfireStore.getState().setSourceStatus("effis", { error: "unavailable" });
    render(<WildfireLegend />);

    expect(
      within(screen.getByTestId("wildfire-source-effis")).getByText("wildfires.sourceUnavailable"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("wildfire-source-nifc")).queryByText("wildfires.sourceUnavailable"),
    ).toBeNull();

    act(() => {
      useWildfireStore.getState().setSourceStatus("nifc", { truncated: true });
    });
    expect(
      within(screen.getByTestId("wildfire-source-nifc")).getByText("wildfires.truncatedForView"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("wildfire-source-effis")).queryByText("wildfires.truncatedForView"),
    ).toBeNull();
  });

  it("describes EFFIS as seven-day satellite burned area and NOAA density qualitatively", () => {
    useWildfireStore.setState({ showNoaaSmoke: true });
    render(<WildfireLegend />);

    const effis = within(screen.getByTestId("wildfire-source-effis"));
    expect(effis.getByText("wildfires.effisSevenDayProduct")).toBeTruthy();
    expect(effis.getByText("wildfires.effisBurnedAreaCaveat")).toBeTruthy();

    const noaa = within(screen.getByTestId("wildfire-source-noaa-hms"));
    expect(noaa.getByText("wildfires.qualitativeDensity")).toBeTruthy();
    for (const density of ["light", "medium", "heavy"]) {
      expect(noaa.getByText(`wildfires.${density}`)).toBeTruthy();
    }
    expect(noaa.getByText("wildfires.noaaObservedSmokeCaveat")).toBeTruthy();
    expect(noaa.getByText("wildfires.noaaSmokeDensityCaveat")).toBeTruthy();
  });

  it("exposes solid, dashed, and density swatches with their rendered semantics", () => {
    render(<WildfireLegend />);

    expect(
      within(screen.getByTestId("wildfire-source-nifc")).getByRole("img", {
        name: "wildfires.reportedPerimeter",
      }),
    ).toHaveAttribute("data-line-style", "solid");
    expect(
      within(screen.getByTestId("wildfire-source-effis")).getByRole("img", {
        name: "wildfires.effisSevenDayProduct",
      }),
    ).toHaveAttribute("data-line-style", "dashed");

    const noaa = within(screen.getByTestId("wildfire-source-noaa-hms"));
    for (const [density, opacity] of [
      ["light", "0.08"],
      ["medium", "0.15"],
      ["heavy", "0.24"],
    ] as const) {
      expect(noaa.getByRole("img", { name: `wildfires.${density}` })).toHaveAttribute(
        "data-fill-opacity",
        opacity,
      );
    }
  });

  it("ships domain-accurate English and German source copy", () => {
    expect(en.wildfires).toMatchObject({
      hotspotAge: "Hotspot age",
      nifcPerimeters: "Reported perimeters",
      effisBurnedAreas: "Satellite-derived burned areas",
      effisSevenDayProduct: "Seven-day satellite-derived burned areas",
      observedSmoke: "Observed smoke",
      coverageGlobal: "Global · NASA FIRMS",
      coverageUnitedStates: "United States · NIFC WFIGS",
      coverageEffisRegion: "Europe and wider EFFIS region · Copernicus EFFIS",
      coverageNorthAmerica: "North America · NOAA HMS",
      zoomInToLoadPolygons: "Zoom in to load polygons",
      qualitativeDensity: "Qualitative density",
    });
    expect(de.wildfires).toMatchObject({
      nifcPerimeters: "Gemeldete Brandflächen",
      effisBurnedAreas: "Satellitengestützte Brandflächen",
      observedSmoke: "Beobachteter Rauch",
      coverageGlobal: "Global · NASA FIRMS",
      coverageUnitedStates: "Vereinigte Staaten · NIFC WFIGS",
      coverageEffisRegion: "Europa und weitere EFFIS-Regionen · Copernicus EFFIS",
      coverageNorthAmerica: "Nordamerika · NOAA HMS",
      qualitativeDensity: "Qualitative Dichte",
    });
    expect(en.wildfires.effisBurnedAreaCaveat).toMatch(/not an authoritative wildfire perimeter/i);
    expect(en.wildfires.noaaObservedSmokeCaveat).toMatch(/not a smoke forecast/i);
    expect(en.wildfires.noaaSmokeDensityCaveat).toMatch(/not a measured.*concentration/i);
  });
});
