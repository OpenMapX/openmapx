import type { OperationalFeedEvidence } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "coverage-sites-test-secret";
});

import { freshenStream } from "./collect.js";
import { siteStreams } from "./sites.js";

const feed = (over: Partial<OperationalFeedEvidence> = {}): OperationalFeedEvidence => ({
  sourceId: "de-bnetza-charging",
  name: "Bundesnetzagentur Ladesäulenregister",
  lastAttemptAt: "2026-10-06T09:55:00.000Z",
  lastOutcome: "changed",
  lastSuccessfulCheckAt: "2026-10-06T09:55:00.000Z",
  lastPublicationAt: "2026-10-06T09:55:00.000Z",
  publicationRevision: "288",
  upstreamAsOf: null,
  freshUntil: "2026-10-06T10:25:00.000Z",
  expectedIntervalSeconds: 300,
  activeEventCount: 5210,
  changedCount: 14,
  rejectedCount: 0,
  consecutiveFailures: 0,
  error: null,
  bindingCounts: null,
  graph: { generation: "graph-7", status: "ready", regions: ["europe"] },
  coverage: [
    { stream: "static", accessMode: "bulk", countries: ["DE"], whole: true, basis: "observed" },
    { stream: "live", accessMode: "bulk", countries: ["DE"], whole: true, basis: "observed" },
  ],
  status: "healthy",
  action: null,
  ...over,
});

const snapshot = (...feeds: OperationalFeedEvidence[]) => ({
  schemaVersion: 1 as const,
  instanceId: "oc-eu-1",
  collectedAt: "2026-10-06T10:00:00.000Z",
  feeds,
});

const AT = new Date("2026-10-06T10:00:00.000Z");

describe("site operational evidence adapter", () => {
  it("gives a feed holding its country whole a static and a live stream there", () => {
    const streams = siteStreams("openconditions", "ev", snapshot(feed()));

    expect(streams.map((stream) => [stream.key, stream.stream])).toEqual([
      ["ev:openconditions:oc-eu-1:de-bnetza-charging:static", "static"],
      ["ev:openconditions:oc-eu-1:de-bnetza-charging:live", "live"],
    ]);
    expect(streams[0]).toMatchObject({
      owner: { kind: "integration", id: "openconditions" },
      sourceId: "de-bnetza-charging",
      attributionSourceId: "de-bnetza-charging",
      consumerInstance: "oc-eu-1",
      domain: "ev",
      presence: "present",
      region: {
        keys: ["country:DE"],
        basis: "observed",
        relation: "unknown",
        label: "Bundesnetzagentur Ladesäulenregister",
      },
      publication: {
        version: "288",
        publishedAt: "2026-10-06T09:55:00.000Z",
        active: true,
      },
      attempt: { at: "2026-10-06T09:55:00.000Z", outcome: "succeeded" },
      lastSuccessfulCheckAt: "2026-10-06T09:55:00.000Z",
      lastSuccessfullyCheckedVersion: "288",
      expiresAt: "2026-10-06T10:25:00.000Z",
      policy: {
        expectedIntervalSeconds: 300,
        staleAt: "2026-10-06T10:25:00.000Z",
        expiresAt: "2026-10-06T10:25:00.000Z",
      },
      reasons: [],
    });
    expect(freshenStream(streams[0]!, AT).freshness).toBe("current");
    // Past the feed's freshness deadline the readings no longer count.
    expect(freshenStream(streams[1]!, new Date("2026-10-06T10:25:00.000Z")).freshness).toBe(
      "expired",
    );
  });

  it("marks a feed holding its country in part (one subdivision) partial", () => {
    const streams = siteStreams(
      "openconditions",
      "parking",
      snapshot(
        feed({
          sourceId: "de-bw-mobidata-parking",
          coverage: [
            {
              stream: "static",
              accessMode: "bulk",
              countries: ["DE"],
              whole: false,
              basis: "observed",
            },
          ],
        }),
      ),
    );

    expect(streams.map((s) => [s.key, s.reasons])).toEqual([
      ["parking:openconditions:oc-eu-1:de-bw-mobidata-parking:static", ["source_partial"]],
    ]);
  });

  it("splits a feed holding some countries whole and others in part", () => {
    const streams = siteStreams(
      "openconditions",
      "ev",
      snapshot(
        feed({
          coverage: [
            {
              stream: "static",
              accessMode: "bulk",
              countries: ["FR"],
              whole: true,
              basis: "observed",
            },
            {
              stream: "static",
              accessMode: "bulk",
              countries: ["DE"],
              whole: false,
              basis: "observed",
            },
          ],
        }),
      ),
    );

    expect(streams.map((s) => [s.key, s.region.keys, s.reasons])).toEqual([
      ["ev:openconditions:oc-eu-1:de-bnetza-charging:static", ["country:FR"], []],
      [
        "ev:openconditions:oc-eu-1:de-bnetza-charging:static:part",
        ["country:DE"],
        ["source_partial"],
      ],
    ]);
  });

  it("keeps a working on-demand feed standing for its country, partial, without recent reads", () => {
    const [stream] = siteStreams(
      "openconditions",
      "fuel",
      snapshot(
        feed({
          sourceId: "at-econtrol-fuel",
          lastAttemptAt: null,
          lastOutcome: null,
          lastSuccessfulCheckAt: null,
          lastPublicationAt: null,
          publicationRevision: null,
          freshUntil: null,
          activeEventCount: null,
          coverage: [
            {
              stream: "static",
              accessMode: "on_demand",
              countries: ["AT"],
              whole: false,
              basis: "declared",
            },
          ],
          status: "unknown",
        }),
      ),
    );

    expect(stream).toMatchObject({
      domain: "fuel",
      stream: "static",
      presence: "present",
      region: { keys: ["country:AT"], basis: "declared" },
      publication: { active: true },
      lastSuccessfulCheckAt: "2026-10-06T10:00:00.000Z",
      reasons: ["source_partial"],
    });
    expect(freshenStream(stream!, AT).freshness).toBe("current");
    expect(freshenStream(stream!, new Date("2026-10-06T10:09:00.000Z")).freshness).toBe("current");
  });

  it("lets a failing on-demand feed lapse with what it last fetched", () => {
    const [stream] = siteStreams(
      "openconditions",
      "ev",
      snapshot(
        feed({
          sourceId: "ocm-charging",
          lastOutcome: "failed",
          consecutiveFailures: 2,
          freshUntil: "2026-10-06T09:59:00.000Z",
          coverage: [
            {
              stream: "static",
              accessMode: "on_demand",
              countries: ["DE"],
              whole: false,
              basis: "observed",
            },
          ],
          status: "failed",
        }),
      ),
    );

    expect(stream?.attempt.outcome).toBe("failed");
    expect(freshenStream(stream!, AT).freshness).toBe("expired");
  });

  it("shows a feed missing credentials as not configured, with what to do", () => {
    const [stream] = siteStreams(
      "openconditions",
      "ev",
      snapshot(
        feed({
          sourceId: "us-afdc-charging",
          lastSuccessfulCheckAt: null,
          publicationRevision: null,
          coverage: [],
          status: "missing_configuration",
          action: "configure_credentials",
        }),
      ),
    );

    expect(stream).toMatchObject({
      key: "ev:openconditions:oc-eu-1:us-afdc-charging:static",
      presence: "not-configured",
      publication: { active: false },
      attempt: {
        outcome: "skipped",
        reasonCode: "not_configured",
        message: "configure_credentials",
      },
      reasons: ["not_configured"],
    });
    expect(freshenStream(stream!, AT).freshness).toBe("not-applicable");
  });

  it("keeps a feed without records as one static stream that says what is known", () => {
    const [failing, empty] = siteStreams(
      "openconditions",
      "ev",
      snapshot(
        feed({
          sourceId: "es-dgt-charging",
          lastOutcome: "failed",
          lastSuccessfulCheckAt: null,
          lastPublicationAt: null,
          publicationRevision: null,
          freshUntil: null,
          activeEventCount: null,
          consecutiveFailures: 3,
          error: "GET https://nap.dgt.es/x.xml?token=abc responded 503",
          coverage: [],
          status: "failed",
        }),
        feed({ sourceId: "lu-chargy-charging", activeEventCount: 0, coverage: [] }),
      ),
    );

    expect(failing).toMatchObject({
      key: "ev:openconditions:oc-eu-1:es-dgt-charging:static",
      presence: "unknown",
      region: { keys: [], basis: "unknown", relation: "unknown" },
      publication: { version: null, active: null },
      attempt: { outcome: "failed", message: "GET [source endpoint] responded 503" },
      reasons: ["region_unknown"],
    });
    expect(empty).toMatchObject({ presence: "empty", region: { keys: [] } });
  });

  it("rejects a snapshot it cannot read", () => {
    expect(() =>
      siteStreams("openconditions", "ev", { ...snapshot(), schemaVersion: 2 as never }),
    ).toThrow();
    expect(() =>
      siteStreams(
        "openconditions",
        "ev",
        snapshot(...Array.from({ length: 501 }, (_, i) => feed({ sourceId: `feed-${i}` }))),
      ),
    ).toThrow();
  });
});
