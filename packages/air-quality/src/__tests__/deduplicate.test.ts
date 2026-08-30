import { describe, expect, it } from "vitest";
import { type DeduplicationRecord, deduplicateRecords } from "../normalize/deduplicate";

const source = (sourceId: string) => ({
  sourceId,
  name: sourceId,
  url: null,
  owner: null,
  license: null,
  methodologyUrl: null,
  attribution: null,
});
const record: DeduplicationRecord = {
  observationId: "obs-b",
  sourceId: "epa-owned-dataset",
  originRecordId: "record-1",
  spatialSupportId: "station-1",
  pollutant: "pm25",
  startAt: "2026-08-30T00:00:00Z",
  endAt: "2026-08-30T01:00:00Z",
  value: 12.3,
  unit: "ug/m3",
  precision: 1,
  sources: [source("redistributor-b")],
};

describe("redistributor deduplication", () => {
  it("merges provenance for equal owner records irrespective of input order", () => {
    const duplicate = {
      ...record,
      observationId: "obs-a",
      value: 0.0123,
      unit: "mg/m3" as const,
      precision: 4,
      sources: [source("redistributor-a")],
    };
    const forward = deduplicateRecords([record, duplicate]);
    const reverse = deduplicateRecords([duplicate, record]);
    expect(forward).toEqual(reverse);
    expect(forward.records[0]?.observationIds).toEqual(["obs-a", "obs-b"]);
    expect(forward.records[0]?.sources.map(({ sourceId }) => sourceId)).toEqual([
      "redistributor-a",
      "redistributor-b",
    ]);
    const sameIdentity = { ...duplicate, observationId: record.observationId };
    expect(deduplicateRecords([record, sameIdentity])).toEqual(
      deduplicateRecords([sameIdentity, record]),
    );
  });

  it("emits a conflict instead of choosing materially different values", () => {
    const result = deduplicateRecords([record, { ...record, observationId: "obs-a", value: 12.5 }]);
    expect(result.records).toEqual([]);
    expect(result.conflicts).toMatchObject([
      { observationIds: ["obs-a", "obs-b"], reason: "duplicate_conflict" },
    ]);
  });

  it("converts source precision into the canonical unit before comparing", () => {
    const canonicalMilligrams = {
      ...record,
      observationId: "obs-a",
      value: 0.0123,
      unit: "mg/m3" as const,
      precision: 4,
    };
    const differentMicrograms = { ...record, observationId: "obs-b", value: 12.5, precision: 1 };

    expect(deduplicateRecords([canonicalMilligrams, differentMicrograms]).conflicts).toHaveLength(
      1,
    );
  });

  it("rejects conflicting attribution metadata for one source ID", () => {
    const result = deduplicateRecords([
      record,
      {
        ...record,
        observationId: "obs-a",
        sources: [{ ...source("redistributor-b"), owner: "Different owner" }],
      },
    ]);

    expect(result.records).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
  });

  it("does not merge records with a different interval or support", () => {
    expect(
      deduplicateRecords([
        record,
        { ...record, observationId: "obs-a", spatialSupportId: "station-2" },
      ]).records,
    ).toHaveLength(2);
  });
});
