import type {
  AirQualityCurrentResponse,
  AirQualityEvidence,
  AirQualityForecastResponse,
  AirQualityIndex,
} from "@openmapx/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const hooks = {
  current: {} as Record<string, unknown>,
  forecast: {} as Record<string, unknown>,
  useCurrent: vi.fn(),
  useForecast: vi.fn(),
};

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useAirQuality: (...args: unknown[]) => hooks.useCurrent(...args),
  useAirQualityForecast: (...args: unknown[]) => hooks.useForecast(...args),
}));

const { PlaceAirQuality } = await import("./PlaceAirQuality");

const AT = "2026-08-30T12:00:00.000Z";

function index(overrides: Partial<AirQualityIndex> = {}): AirQualityIndex {
  return {
    indexId: "index-primary",
    standardId: "eu-eea-current",
    standardRevision: "eea-2026",
    methodId: "eea-eaqi",
    methodRevision: "2026",
    effectiveDate: "2026-01-01",
    value: 3,
    displayValue: "3",
    categoryId: "moderate",
    dominantPollutants: ["pm25", "o3"],
    authority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    derivation: "published-index",
    inputObservationIds: ["evidence-ground"],
    ...overrides,
  };
}

function evidence(overrides: Partial<AirQualityEvidence> = {}): AirQualityEvidence {
  return {
    observationId: "evidence-ground",
    providerId: "fixture-provider",
    sourceIds: ["fixture-source"],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    indices: [index()],
    pollutants: [
      {
        pollutant: "pm25",
        value: 18.4,
        unit: "ug/m3",
        originalValue: 18.4,
        originalUnit: "µg/m³",
        averagingPeriodMinutes: 60,
        intervalStart: "2026-08-30T11:00:00.000Z",
        intervalEnd: AT,
        sampleCount: 1,
        expectedSampleCount: 1,
        completenessPercent: 100,
        gapFilled: false,
        estimated: false,
        sensorId: "sensor-1",
      },
    ],
    observedAt: AT,
    forecastFor: null,
    publishedAt: AT,
    validUntil: "2026-08-30T13:00:00.000Z",
    freshness: "fresh",
    spatial: {
      kind: "station",
      id: "station-1",
      name: "Reference monitor",
      coordinates: [13.4, 52.5],
      timeZone: "Europe/Berlin",
      distanceMeters: 450,
      stationClass: "reference",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    completenessByStandard: {
      "eu-eea-current": { passes: true, missingRequirements: [] },
    },
    sources: [
      {
        sourceId: "fixture-source",
        name: "Fixture authority",
        url: "https://example.test/data",
        owner: "Fixture ministry",
        license: { name: "CC BY 4.0", url: "https://example.test/license" },
        methodologyUrl: "https://example.test/method",
        attribution: "Fixture authority attribution",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function response(overrides: Partial<AirQualityCurrentResponse> = {}): AirQualityCurrentResponse {
  return {
    status: "ok",
    jurisdiction: {
      countryCode: "DE",
      subdivisionCode: "DE-BE",
      programId: "eea-european-aqi",
      resolution: "boundary-artifact",
      resolverId: "natural-earth",
      resolverRevision: "1",
      requestHintMatched: true,
      localStandardId: "eu-eea-current",
    },
    primaryEvidenceId: "evidence-ground",
    primaryIndexId: "index-primary",
    comparisonStandardId: null,
    comparisonIndexIds: [],
    evidence: [evidence()],
    selection: { reasons: ["local_standard", "published_by_agency"], rejected: [] },
    meta: {
      generatedAt: AT,
      cache: "miss",
      providersCandidate: ["fixture-provider"],
      providersServed: ["fixture-provider"],
      providersFailed: [],
      providersPolicyExcluded: [],
      truncated: false,
      warnings: [],
    },
    ...overrides,
  };
}

function forecast(): AirQualityForecastResponse {
  const first = evidence({
    observationId: "forecast-ground",
    observedAt: null,
    forecastFor: AT,
    indices: [index({ indexId: "forecast-index", inputObservationIds: ["forecast-ground"] })],
  });
  const model = evidence({
    observationId: "forecast-model",
    providerId: "model-provider",
    basis: "model",
    qualityStatus: "estimated",
    observedAt: null,
    forecastFor: "2026-08-30T13:00:00.000Z",
    spatial: {
      ...evidence().spatial,
      kind: "grid-cell",
      id: "grid-1",
      name: "CAMS grid",
      stationClass: null,
      distanceMeters: null,
      coverageMethod: "provider-point-lookup",
    },
    indices: [],
  });
  return {
    status: "partial",
    jurisdiction: response().jurisdiction,
    window: {
      startAt: AT,
      endAt: "2026-09-01T12:00:00.000Z",
      requestedHours: 48,
    },
    comparisonStandardId: null,
    evidence: [first, model],
    series: [
      {
        seriesId: "ground-series",
        providerId: "fixture-provider",
        spatialSupportId: "station-1",
        basis: "ground",
        evidenceIds: ["forecast-ground"],
      },
      {
        seriesId: "model-series",
        providerId: "model-provider",
        spatialSupportId: "grid-1",
        basis: "model",
        evidenceIds: ["forecast-model"],
      },
    ],
    frames: [
      {
        frameAt: AT,
        status: "ok",
        evidenceIds: ["forecast-ground"],
        primary: { evidenceId: "forecast-ground", indexId: "forecast-index" },
        comparison: [],
        selection: { reasons: ["local_standard"], rejected: [] },
      },
      {
        frameAt: "2026-08-30T13:00:00.000Z",
        status: "partial",
        evidenceIds: ["forecast-model"],
        primary: { evidenceId: "forecast-model", indexId: null },
        comparison: [],
        selection: { reasons: ["raw_fallback"], rejected: [] },
      },
      {
        frameAt: "2026-08-30T14:00:00.000Z",
        status: "unavailable",
        evidenceIds: [],
        primary: null,
        comparison: [],
        selection: { reasons: [], rejected: [] },
      },
    ],
    meta: response().meta,
  };
}

function renderSection() {
  return render(
    <PlaceAirQuality lat={52.5} lng={13.4} enabled countryCode="DE" subdivisionCode="DE-BE" />,
  );
}

beforeEach(() => {
  hooks.useCurrent.mockReset();
  hooks.useForecast.mockReset();
  hooks.current = { data: response(), isLoading: false, isError: false, error: null };
  hooks.forecast = { data: undefined, isLoading: false, isError: false, error: null };
  hooks.useCurrent.mockImplementation(() => hooks.current);
  hooks.useForecast.mockImplementation(() => hooks.forecast);
});

describe("PlaceAirQuality", () => {
  it("renders loading, request-error, and valid unavailable states distinctly", () => {
    hooks.current = { data: undefined, isLoading: true, isError: false, error: null };
    const view = renderSection();
    expect(screen.getByRole("status")).toHaveTextContent("airQuality.loading");

    hooks.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("offline"),
    };
    view.rerender(<PlaceAirQuality lat={52.5} lng={13.4} enabled />);
    expect(screen.getByRole("alert")).toHaveTextContent("airQuality.requestError");

    hooks.current = {
      data: response({
        status: "unavailable",
        primaryEvidenceId: null,
        primaryIndexId: null,
        evidence: [],
      }),
      isLoading: false,
      isError: false,
      error: null,
    };
    view.rerender(<PlaceAirQuality lat={52.5} lng={13.4} enabled />);
    expect(screen.getByRole("status")).toHaveTextContent("airQuality.unavailable");
  });

  it("renders an official preliminary ground headline with complete context and sources", () => {
    renderSection();
    expect(
      screen.getByRole("heading", { level: 3, name: "airQuality.currentHeading" }),
    ).toBeVisible();
    expect(screen.getByText("airQuality.category.moderate")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getAllByText("airQuality.provenance.officialGround").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) =>
        Boolean(element?.textContent?.includes("airQuality.quality.preliminary")),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) =>
        Boolean(element?.textContent?.includes("airQuality.freshness.fresh")),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) =>
        Boolean(
          element?.textContent?.includes("airQuality.pollutant.pm25, airQuality.pollutant.o3"),
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Reference monitor/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/450/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) =>
        Boolean(element?.textContent?.includes("Fixture ministry")),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "airQuality.methodology" })).toHaveAttribute(
      "href",
      "https://example.test/method",
    );
    expect(screen.getByText("airQuality.informationalOnly")).toBeVisible();
  });

  it("shows non-covering official evidence even when no record qualifies as a headline", () => {
    const secondary = evidence({
      observationId: "evidence-eccc-community",
      providerId: "eccc-aqhi",
      pollutants: [],
      indices: [
        index({
          indexId: "index-eccc-unverified",
          standardId: null,
          standardRevision: null,
          methodId: "eccc-geomet-aqhi-observation-method-unspecified",
          value: 2.7,
          displayValue: "2.7",
          categoryId: "eccc-published-aqhi-method-unspecified",
          dominantPollutants: [],
          inputObservationIds: ["evidence-eccc-community"],
        }),
      ],
      spatial: {
        kind: "community",
        id: "ECCC-FCWYG",
        name: "Toronto Downtown",
        coordinates: [-79.3969444, 43.6758333],
        timeZone: null,
        distanceMeters: 1_200,
        stationClass: null,
        mobile: null,
        coversRequestedPoint: false,
        coverageMethod: "nearest-community",
      },
    });
    hooks.current = {
      data: response({
        status: "partial",
        primaryEvidenceId: null,
        primaryIndexId: null,
        evidence: [secondary],
      }),
      isLoading: false,
      isError: false,
      error: null,
    };

    renderSection();

    expect(screen.queryByText("airQuality.unavailable")).not.toBeInTheDocument();
    expect(screen.getByText("airQuality.noQualifyingLocalIndex")).toBeVisible();
    expect(screen.getByRole("heading", { name: "airQuality.evidence.heading" })).toBeVisible();
    expect(screen.getByText(/2\.7/)).toBeVisible();
    expect(screen.getByText(/Toronto Downtown/)).toBeVisible();
    expect(screen.getByText("airQuality.coverage.notForRequestedPoint")).toBeVisible();
  });

  it.each([
    ["ground", "openmapx-computed-index", "openmapx", "airQuality.provenance.computedGround"],
    ["ground", null, null, "airQuality.provenance.rawGround"],
    ["model", null, null, "airQuality.provenance.rawModel"],
    ["hybrid", null, null, "airQuality.provenance.rawHybrid"],
  ] as const)(
    "renders %s evidence without changing its provenance",
    (basis, derivation, authority, key) => {
      const item = evidence({
        basis,
        indices:
          derivation === null
            ? []
            : [index({ basis, derivation, authority: authority ?? "openmapx" })],
      });
      hooks.current = {
        data: response({
          primaryIndexId: derivation === null ? null : "index-primary",
          evidence: [item],
          selection: {
            reasons: derivation === null ? ["raw_fallback"] : ["local_standard"],
            rejected: [],
          },
        }),
        isLoading: false,
        isError: false,
        error: null,
      };
      renderSection();
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
      if (derivation === null) {
        expect(screen.getByText("airQuality.noQualifyingLocalIndex")).toBeVisible();
        expect(screen.getAllByText(/18.4 µg\/m³/).length).toBeGreaterThan(0);
      }
    },
  );

  it("keeps ground and model evidence in separate visible cards and exposes quality flags", () => {
    const ground = evidence({
      pollutants: [
        { ...evidence().pollutants[0], estimated: true, gapFilled: true, completenessPercent: 75 },
      ],
    });
    const model = evidence({
      observationId: "evidence-model",
      providerId: "model-provider",
      basis: "model",
      indices: [],
      qualityStatus: "estimated",
    });
    hooks.current = {
      data: response({ evidence: [ground, model], status: "partial" }),
      isLoading: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByTestId("air-quality-evidence-ground")).toHaveTextContent(
      "airQuality.basis.ground",
    );
    expect(screen.getByTestId("air-quality-evidence-model")).toHaveTextContent(
      "airQuality.basis.model",
    );
    expect(screen.getAllByText("airQuality.flag.estimated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("airQuality.flag.gapFilled").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/75%/).length).toBeGreaterThan(0);
  });

  it("labels stale and partial evidence and does not emit unsafe source links", () => {
    const stale = evidence({
      freshness: "stale",
      sources: [
        {
          ...evidence().sources[0],
          url: "javascript:alert(1)",
          methodologyUrl: "javascript:alert(2)",
        },
      ],
      warnings: ["stale_evidence"],
    });
    hooks.current = {
      data: response({
        status: "partial",
        evidence: [stale],
        meta: { ...response().meta, warnings: ["stale_evidence", "partial_providers"] },
      }),
      isLoading: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(
      screen.getAllByText((_, element) =>
        Boolean(element?.textContent?.includes("airQuality.freshness.stale")),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("airQuality.warning.staleEvidence")).toBeVisible();
    expect(screen.getByText("airQuality.warning.partialProviders")).toBeVisible();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("keeps comparison session-only, leaves the local primary visible, and resets on remount", () => {
    const view = renderSection();
    const comparison = screen.getByRole("combobox", { name: "airQuality.comparison.label" });
    expect(comparison).toHaveValue("");
    fireEvent.change(comparison, { target: { value: "us-epa-2024" } });
    expect(hooks.useCurrent).toHaveBeenLastCalledWith(
      52.5,
      13.4,
      expect.objectContaining({ comparisonStandard: "us-epa-2024" }),
    );
    expect(screen.getByText("airQuality.category.moderate")).toBeVisible();
    view.unmount();
    renderSection();
    expect(screen.getByRole("combobox", { name: "airQuality.comparison.label" })).toHaveValue("");
  });

  it("labels successful and missing comparisons without replacing the local headline", () => {
    const comparisonIndex = index({
      indexId: "comparison-index",
      standardId: "us-epa-2024",
      displayValue: "67",
      categoryId: "moderate",
    });
    hooks.current = {
      data: response({
        comparisonStandardId: "us-epa-2024",
        comparisonIndexIds: ["comparison-index"],
        evidence: [evidence({ indices: [index(), comparisonIndex] })],
      }),
      isLoading: false,
      isError: false,
      error: null,
    };
    const view = renderSection();
    expect(screen.getByText("airQuality.comparison.heading")).toBeVisible();
    expect(screen.getByText(/67/)).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();

    hooks.current = {
      data: response({
        comparisonStandardId: "us-epa-2024",
        comparisonIndexIds: [],
        meta: { ...response().meta, warnings: ["comparison_unavailable"] },
        selection: {
          reasons: ["local_standard"],
          rejected: [
            {
              evidenceId: "evidence-ground",
              indexId: null,
              reasons: ["incomplete_window"],
              missingRequirements: ["No complete EPA pollutant window"],
            },
          ],
        },
      }),
      isLoading: false,
      isError: false,
      error: null,
    };
    view.rerender(<PlaceAirQuality lat={52.5} lng={13.4} enabled />);
    expect(screen.getByText("airQuality.comparison.unavailable")).toBeVisible();
    expect(screen.getByText("airQuality.requirement.epaWindow")).toBeVisible();
  });

  it("loads forecast lazily and renders distinct canonical series and frame statuses", () => {
    hooks.forecast = { data: forecast(), isLoading: false, isError: false, error: null };
    renderSection();
    expect(hooks.useForecast).toHaveBeenLastCalledWith(
      52.5,
      13.4,
      expect.objectContaining({ enabled: false, hours: 48 }),
    );
    const toggle = screen.getByRole("button", { name: "airQuality.forecast.show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(hooks.useForecast).toHaveBeenLastCalledWith(
      52.5,
      13.4,
      expect.objectContaining({ enabled: true, hours: 48 }),
    );
    const ground = screen.getByTestId("air-quality-forecast-ground-series");
    const model = screen.getByTestId("air-quality-forecast-model-series");
    expect(ground).toHaveTextContent("airQuality.basis.ground");
    expect(ground).toHaveTextContent("airQuality.provenance.officialGround");
    expect(ground).toHaveTextContent("airQuality.quality.preliminary");
    expect(ground).toHaveTextContent("airQuality.freshness.fresh");
    expect(model).toHaveTextContent("airQuality.basis.model");
    expect(model).toHaveTextContent("airQuality.provenance.rawModel");
    expect(model).toHaveTextContent("airQuality.quality.estimated");
    expect(model).toHaveTextContent("airQuality.noQualifyingLocalIndex");
    const frames = screen.getByTestId("air-quality-forecast-frames");
    expect(within(frames).getByText("airQuality.frame.ok")).toBeVisible();
    expect(within(frames).getByText("airQuality.frame.partial")).toBeVisible();
    expect(within(frames).getByText("airQuality.frame.unavailable")).toBeVisible();
    expect(screen.getAllByText("Fixture authority attribution").length).toBeGreaterThan(0);
  });

  it("shows community, distance, and non-coverage context for secondary forecasts", () => {
    const data = forecast();
    const model = data.evidence.find(({ observationId }) => observationId === "forecast-model");
    if (!model) throw new Error("forecast model fixture missing");
    model.indices = [
      index({
        indexId: "forecast-eccc-unverified",
        standardId: null,
        standardRevision: null,
        methodId: "eccc-geomet-aqhi-forecast-method-unspecified",
        value: 2.7,
        displayValue: "2.7",
        categoryId: "eccc-published-aqhi-method-unspecified",
        dominantPollutants: [],
        inputObservationIds: ["forecast-model"],
      }),
    ];
    model.pollutants = [];
    model.spatial = {
      kind: "community",
      id: "ECCC-FCWYG",
      name: "Toronto Downtown",
      coordinates: [-79.3969444, 43.6758333],
      timeZone: null,
      distanceMeters: 1_200,
      stationClass: null,
      mobile: null,
      coversRequestedPoint: false,
      coverageMethod: "nearest-community",
    };
    hooks.forecast = { data, isLoading: false, isError: false, error: null };

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "airQuality.forecast.show" }));

    const series = screen.getByTestId("air-quality-forecast-model-series");
    expect(within(series).getByText(/Toronto Downtown/)).toBeVisible();
    expect(within(series).getByText(/1200/)).toBeVisible();
    expect(within(series).getByText("airQuality.coverage.notForRequestedPoint")).toBeVisible();
  });

  it("keeps semantic headings and keyboard controls in a logical focus order", async () => {
    const user = userEvent.setup();
    hooks.forecast = { data: forecast(), isLoading: false, isError: false, error: null };
    renderSection();

    const currentHeading = screen.getByRole("heading", {
      level: 3,
      name: "airQuality.currentHeading",
    });
    const evidenceHeading = screen.getByRole("heading", {
      level: 3,
      name: "airQuality.evidence.heading",
    });
    const comparison = screen.getByRole("combobox", { name: "airQuality.comparison.label" });
    const forecastToggle = screen.getByRole("button", { name: "airQuality.forecast.show" });

    expect(
      currentHeading.compareDocumentPosition(comparison) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      comparison.compareDocumentPosition(evidenceHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      evidenceHeading.compareDocumentPosition(forecastToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    comparison.focus();
    await user.selectOptions(comparison, "us-epa-2024");
    expect(comparison).toHaveValue("us-epa-2024");

    forecastToggle.focus();
    await user.keyboard("{Enter}");
    expect(forecastToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("air-quality-forecast-frames")).toBeVisible();
  });
});
