import type { HazardAlert, HazardsProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { type alertsToFeatureCollection, alertToFeature, setup } from "./index.js";

const NOTICE = "Warnings are provided as issued by the national meteorological services.";

function alert(over: Partial<HazardAlert> = {}): HazardAlert {
  return {
    id: "oc:situation:eu-meteoalarm-alerts:2.49.0.0.250.0.ES.1",
    type: "wind",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-4, 40],
          [-3, 40],
          [-3, 41],
          [-4, 40],
        ],
      ],
    },
    event: "Wind",
    headline: "Yellow wind warning",
    description: "Gusts up to 80 km/h.",
    instruction: "Secure loose objects.",
    areaDescription: "Madrid",
    severity: "Moderate",
    urgency: "Expected",
    certainty: "Likely",
    sent: "2026-10-09T06:00:00Z",
    effective: "2026-10-09T07:00:00Z",
    expires: "2026-10-09T18:00:00Z",
    senderName: "AEMET",
    // MeteoAlarm's CAP `web` is the national service's page.
    web: "https://www.aemet.es/en/eltiempo/prediccion/avisos",
    sources: ["eu-meteoalarm-alerts"],
    attributions: [],
    notices: [NOTICE],
    ...over,
  };
}

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function callEvents(providers: HazardsProvider[], query: Record<string, string> = {}) {
  const base = createMockIntegrationContext();
  const ctx = {
    ...base,
    getIntegrationsByDomain: (domain: string) =>
      domain === "hazards"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["hazards", [p]]]) }))
        : [],
  } as unknown as Parameters<typeof setup>[0];
  setup(ctx);
  const route = base.registered.routes.find((r) => r.method === "GET" && r.path === "/events");
  if (!route) throw new Error("no /events route");

  const sent: Sent = { status: 200, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  await route.handler({ query, params: {}, headers: {} } as never, reply as never);
  return sent;
}

function provider(over: Partial<HazardsProvider> = {}): HazardsProvider {
  return {
    id: "hazards-test",
    coverage: { all: true },
    getAlerts: async () => ({ alerts: [] }),
    getNaturalHazards: async () => ({ hazards: [] }),
    getFirePixels: async () => ({ pixels: [] }),
    getFireDensity: async () => ({ cells: [], sources: [] }),
    ...over,
  };
}

describe("alertToFeature", () => {
  it("carries the notice, the issuer and the issue time", () => {
    const { properties } = alertToFeature(alert());
    expect(properties).toMatchObject({
      title: "Yellow wind warning",
      severity: "Moderate",
      areaDesc: "Madrid",
      source: "eu-meteoalarm-alerts",
      sourceUrl: "https://www.aemet.es/en/eltiempo/prediccion/avisos",
      geometryType: "polygon",
      sent: "2026-10-09T06:00:00Z",
      senderName: "AEMET",
      notices: [NOTICE],
      sources: ["eu-meteoalarm-alerts"],
    });
  });

  it("takes the onset, else the effective time, else the issue time", () => {
    expect(alertToFeature(alert({ onset: "2026-10-09T08:00:00Z" })).properties.onset).toBe(
      "2026-10-09T08:00:00Z",
    );
    expect(alertToFeature(alert()).properties.onset).toBe("2026-10-09T07:00:00Z");
    expect(alertToFeature(alert({ effective: undefined })).properties.onset).toBe(
      "2026-10-09T06:00:00Z",
    );
  });

  it("draws a point alert as a point and falls back to the event for the title", () => {
    const { properties } = alertToFeature(
      alert({ geometry: { type: "Point", coordinates: [1, 2] }, headline: undefined }),
    );
    expect(properties.geometryType).toBe("point");
    expect(properties.title).toBe("Wind");
  });
});

describe("GET /events", () => {
  it("serves the alerts of the provider and names the feed ids it served", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({
      alerts: [alert(), alert({ id: "b", sources: ["de-dwd-alerts"], notices: [] })],
    }));

    const sent = await callEvents([provider({ getAlerts })], { lang: "de" });

    expect(getAlerts).toHaveBeenCalledWith([-180, -90, 180, 90], {
      simplifyDeg: 0.01,
      lang: "de",
    });
    expect(sent.status).toBe(200);
    // The route caches 60 s; the browser must not reuse an answer on top (MeteoAlarm's ten minutes).
    expect(sent.headers["Cache-Control"]).toBe("no-cache");
    const body = sent.body as ReturnType<typeof alertsToFeatureCollection>;
    expect(body.sources).toEqual(["de-dwd-alerts", "eu-meteoalarm-alerts"]);
    expect(body.features[0].properties.notices).toEqual([NOTICE]);
    expect(body.features[0].properties.senderName).toBe("AEMET");
  });

  it("reads any language other than German as English", async () => {
    const getAlerts = vi.fn<HazardsProvider["getAlerts"]>(async () => ({ alerts: [] }));
    await callEvents([provider({ getAlerts })], { lang: "../etc" });
    await callEvents([provider({ getAlerts })], { lang: "fr" });
    await callEvents([provider({ getAlerts })]);
    await callEvents([provider({ getAlerts })], { lang: "de-AT" });
    expect(getAlerts.mock.calls.map((call) => call[1]?.lang)).toEqual(["en", "en", "en", "de"]);
  });

  it("serves an empty collection when no alert is in effect", async () => {
    const sent = await callEvents([provider()]);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ type: "FeatureCollection", features: [], sources: [] });
  });

  it("answers 503 when every provider failed", async () => {
    const getAlerts = async () => {
      throw new Error("upstream down");
    };
    const sent = await callEvents([provider({ getAlerts })]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("answers 503 when no hazards provider is configured: no source is not no alerts", async () => {
    const sent = await callEvents([]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("serves what the others returned when one provider failed", async () => {
    const failing = provider({
      id: "failing",
      getAlerts: async () => {
        throw new Error("upstream down");
      },
    });
    const working = provider({ id: "working", getAlerts: async () => ({ alerts: [alert()] }) });
    const sent = await callEvents([failing, working]);
    expect(sent.status).toBe(200);
    expect((sent.body as { features: unknown[] }).features).toHaveLength(1);
  });
});
