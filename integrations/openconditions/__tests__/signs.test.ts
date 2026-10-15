import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import type { LatestReading } from "../features/record.js";
import { setup } from "../index.js";
import { recordToMessageSign } from "../signs/map.js";
import { createMessageSignProvider } from "../signs/provider.js";
import type { LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featuresResponse from "./fixtures/features-signs.json" with { type: "json" };

/*
 * `features-signs.json` is a documented sample of the
 * `GET /features?kind=vms&canonical=1&expand=components,latest` answer for
 * two 511NY signs; see fixtures/README.md.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [-74.0, 42.6, -73.7, 42.9];
const SHOWING = "oc:feature:us-ny-511-signs:nySigns:Sample:_S-101";
const BLANK = "oc:feature:us-ny-511-signs:nySigns:Sample:_S-102";

type Body = { records: Rec[]; latest: Record<string, Rec[]> };
const body = () => structuredClone(featuresResponse) as unknown as Body;

const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  crowd: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

function providerWith(answer: unknown, sources: LiveSources = EVERY_SOURCE) {
  const http = fakeHttpClient((req: FakeHttpRequest) =>
    req.url === `${BASE_URL}/features` ? answer : undefined,
  );
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createMessageSignProvider(client, sources) };
}

describe("message-signs-openconditions", () => {
  test("reads the canonical vms features with the newest display of their face", async () => {
    const { http, provider } = providerWith(body());
    const { signs, partial } = await provider.searchSigns(BBOX);

    expect(http.calls[0]?.options?.params).toMatchObject({
      bbox: BBOX.join(","),
      kind: "vms",
      canonical: 1,
      expand: "components,latest",
      limit: 500,
    });
    expect(partial).toBeUndefined();
    expect(signs.map((s) => s.id)).toEqual([SHOWING, BLANK]);
    expect(signs[0]).toEqual({
      id: SHOWING,
      name: "I-87 NB VMS AT EXIT 6",
      type: "matrix",
      coordinates: [-73.79, 42.78],
      location: "I-87 N at MP 6.1",
      road: "I-87",
      direction: "N",
      operator: { name: "NY Signs - Sample Region" },
      status: "in_service",
      pages: [
        ["CRASH AHEAD", "EXIT 7"],
        ["RIGHT LANE", "CLOSED"],
      ],
      updatedAt: "2026-10-13T23:02:17Z",
      sources: ["us-ny-511-signs"],
      attributions: [
        {
          sourceId: "us-ny-511-signs",
          name: "511NY / New York State DOT",
          attributionText: "511NY / New York State DOT",
          licensing: {
            version: 1,
            bindings: [],
            declarations: [{ text: "LicenseRef-511NY-DAA", url: "https://511ny.org/help/24" }],
          },
        },
      ],
    });
    expect(signs[1]).toMatchObject({ status: "blank", pages: [] });
  });

  test("serves nothing until the source list arrives, and nothing of a source it does not list", async () => {
    const waiting = providerWith(body(), { ...EVERY_SOURCE, ready: false });
    await expect(waiting.provider.searchSigns(BBOX)).resolves.toEqual({
      signs: [],
      partial: "unavailable",
    });
    await expect(waiting.provider.getSign(SHOWING)).resolves.toBeNull();
    const unlisted = providerWith(body(), { ...EVERY_SOURCE, has: () => false });
    await expect(unlisted.provider.searchSigns(BBOX)).resolves.toEqual({ signs: [] });
  });

  test("shows a sign whose display reading is gone with an unknown status and no message", () => {
    const answer = body();
    const sign = recordToMessageSign(answer.records[0]!, []);
    expect(sign).toMatchObject({ status: "unknown", pages: [] });
    expect(sign?.updatedAt).toBeUndefined();
  });

  test("takes no message from a sign that is not in service", () => {
    const answer = body();
    const [reading] = answer.latest[SHOWING]! as unknown as LatestReading[];
    ((reading!.result as Rec).value as Rec).workingStatus = "fault";
    const sign = recordToMessageSign(
      answer.records[0]!,
      answer.latest[SHOWING] as unknown as LatestReading[],
    );
    expect(sign).toMatchObject({ status: "fault", pages: [] });
  });

  test("setup registers the message-signs provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.messageSigns.map((p) => p.id)).toEqual(["message-signs-openconditions"]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.messageSigns).toEqual([]);
  });

  test("the data-flow disclosure names what signs send and receive", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const domain = strings.dataSources["domain:message-signs"];
      expect(domain.purpose).toBeTruthy();
      expect(domain.dataSent).toBeTruthy();
      expect(domain.dataReceived).toBeTruthy();
    }
  });
});
