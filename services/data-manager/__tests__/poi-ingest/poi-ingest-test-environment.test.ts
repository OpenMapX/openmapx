import "./support/poi-ingest-environment.js";

import { describe, expect, it } from "vitest";
import { runStaticIngest } from "../../src/jobs/poi-ingest/pipeline.js";
import {
  getPoiIngestTestMocks,
  makePoiIngestResult,
  resetPoiIngestTestMocks,
  staticPoiSource,
} from "./support/poi-ingest-environment";

describe("POI ingest test environment", () => {
  it("builds independent source fixtures", () => {
    const first = staticPoiSource("alpha");
    const second = staticPoiSource("alpha");

    expect(first).toMatchObject({ id: "alpha", stationIdPrefix: "alpha:", name: "alpha" });
    expect(second).toMatchObject({ id: "alpha", stationIdPrefix: "alpha:", name: "alpha" });
    expect(first).not.toBe(second);
    expect(first.static).not.toBe(second.static);
  });

  it("restores deterministic persistence defaults", async () => {
    const mocks = getPoiIngestTestMocks();
    mocks.createPoiJobRowMock.mockResolvedValueOnce("temporary");
    resetPoiIngestTestMocks();

    await expect(mocks.createPoiJobRowMock({})).resolves.toBe("job-1");
    await expect(mocks.getLastPoiFeedStateMock("alpha")).resolves.toBeUndefined();
  });

  it("labels result fixtures with the supplied source and kind", () => {
    expect(makePoiIngestResult("alpha", "live", { liveRowCount: 3 })).toMatchObject({
      sourceId: "alpha",
      kind: "live",
      status: "ok",
      liveRowCount: 3,
    });
  });

  it("installs the pipeline mock before production imports", async () => {
    const mocks = getPoiIngestTestMocks();
    const expected = makePoiIngestResult("alpha", "static");
    mocks.runStaticIngestMock.mockResolvedValueOnce(expected);

    await expect(runStaticIngest({} as never)).resolves.toEqual(expected);
    expect(mocks.runStaticIngestMock).toHaveBeenCalledTimes(1);
  });
});
