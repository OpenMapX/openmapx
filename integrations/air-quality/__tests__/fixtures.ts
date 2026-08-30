import type { ProviderEvidence } from "@openmapx/air-quality";
import { observationId } from "@openmapx/air-quality/ids";
import type {
  AirQualityProvider,
  LoadedIntegration,
  RouteHandler,
} from "@openmapx/integration-framework";

export function evidence(input: {
  at: string;
  longitude?: number;
  latitude?: number;
  forecast?: boolean;
  spatialId?: string;
  providerId?: string;
  sourceId?: string;
  value?: number;
}): ProviderEvidence {
  const providerId = input.providerId ?? "fixture-provider";
  const sourceId = input.sourceId ?? "fixture-source";
  const spatialId = input.spatialId ?? "fixture-station";
  const obsId = observationId({
    sourceId,
    originRecordId: `${spatialId}:${input.at}`,
    spatialSupportId: spatialId,
    modelRunId: null,
    evaluatedAt: input.at,
  });
  return {
    observationId: obsId,
    providerId,
    sourceIds: [sourceId],
    dataAuthority: "official-agency",
    qualityStatus: "quality-assured",
    basis: "ground",
    originRecords: [{ sourceId, recordId: `${spatialId}:${input.at}` }],
    modelRunId: null,
    verticalLevel: null,
    series: (["pm25", "no2", "o3"] as const).map((pollutant) => ({
      seriesId: `${spatialId}:${pollutant}`,
      coherenceKey: spatialId,
      pollutant,
      sensorId: `${spatialId}:${pollutant}:sensor`,
      spatialSupportId: spatialId,
      cadenceMinutes: 60,
      originalUnit: "µg/m³",
      samples: Array.from({ length: 24 }, (_, index) => {
        const end = Date.parse(input.at) - index * 3_600_000;
        return {
          startAt: new Date(end - 3_600_000).toISOString(),
          endAt: new Date(end).toISOString(),
          value: input.value ?? 12,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        };
      }),
    })),
    publishedIndices: [],
    observedAt: input.forecast ? null : input.at,
    forecastFor: input.forecast ? input.at : null,
    publishedAt: null,
    validUntil: new Date(Date.parse(input.at) + 3_600_000).toISOString(),
    spatial: {
      kind: "station",
      id: spatialId,
      name: spatialId,
      coordinates: [input.longitude ?? 13.405, input.latitude ?? 52.52],
      timeZone: "Europe/Berlin",
      distanceMeters: 500,
      stationClass: "reference",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    sources: [
      {
        sourceId,
        name: "Fixture source",
        url: "https://example.test/data",
        owner: "Fixture authority",
        license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
        methodologyUrl: "https://example.test/method",
        attribution: "Fixture authority",
      },
    ],
  };
}

export function integration(provider: AirQualityProvider): LoadedIntegration {
  return {
    id: `${provider.id}-integration`,
    manifest: {
      id: `${provider.id}-integration`,
      version: "1.0.0",
      domains: ["air-quality"],
      dataSources: provider.sourceIds.map((sourceId) => ({
        sourceId,
        name: "Fixture source",
        url: "https://example.test",
      })),
    } as LoadedIntegration["manifest"],
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["air-quality", [provider]]]),
    strings: {},
    shutdownHandlers: [],
  };
}

export function fakeReply() {
  const state: { statusCode: number; payload: unknown; headers: Record<string, string> } = {
    statusCode: 200,
    payload: undefined,
    headers: {},
  };
  const reply = {
    send(value: unknown) {
      state.payload = value;
    },
    status(code: number) {
      state.statusCode = code;
      return { send: (value: unknown) => (state.payload = value) };
    },
    header(name: string, value: string) {
      state.headers[name] = value;
    },
    type() {},
  };
  return { state, reply: reply as Parameters<RouteHandler>[1] };
}
