import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ReferenceFrame, scoreFrames, validateCorpus } from "./oracle";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("independent development source references", () => {
  it("retains verified provenance without claiming held-out or full-layout truth", () => {
    const records = read("source-review-records.json");
    const frames = read("development-references.json") as ReferenceFrame[];
    expect(validateCorpus(frames)).toEqual([]);
    expect(frames).toHaveLength(13);
    for (const frame of frames) {
      const record = records.cases.find((c: { id: string }) => c.id === frame.id);
      expect(frame.evidenceHash).toBe(
        createHash("sha256").update(JSON.stringify(record)).digest("hex"),
      );
      expect(frame.photo?.hash).toBe(record.source.sha256);
      expect(frame.split).toBe("development");
      expect(frame.truth?.clearMarkedSupported ?? false).toBe(false);
      for (const fragment of frame.truth?.travelLaneFragments ?? []) {
        const mask = record.masks.find(
          (m: { polygon: number[][]; adopted: boolean }) =>
            m.adopted && JSON.stringify(m.polygon) === JSON.stringify(fragment.polygon),
        );
        expect(mask).toBeDefined();
        expect(mask.author).toBe(records.reviewers.second);
        expect(mask.firstCrossReview.decision).toBe("accept");
        expect(fragment.lane).toBe(mask.lane);
        expect(mask.sourceSha256).toBe(record.source.sha256);
      }
    }
    expect(frames.filter((f) => f.truth?.photoRelevant)).toHaveLength(6);
    expect(frames.filter((f) => f.truth?.photoRelevant === false)).toHaveLength(2);
    expect(frames.filter((f) => !f.truth)).toHaveLength(5);
  });

  it("preserves Ruhr's two compatible lanes and disputed divider and arrow decisions", () => {
    const records = read("source-review-records.json");
    const record = records.cases.find((c: { id: string }) => c.id === "ruhr-7");
    const frames = read("development-references.json") as ReferenceFrame[];
    expect(frames.find((f) => f.id === "ruhr-7")?.truth?.preferredLanes).toEqual([0, 1]);
    const divider = record.masks.find((m: { id: string }) => m.id === "second:ruhr-7:laneMasks:0");
    expect(divider.adopted).toBe(false);
    expect(divider.secondAdjudication.decision).toBe("accept");
    expect(divider.firstCrossReview.decision).toBe("reject");
    const arrow = record.masks.find((m: { id: string }) => m.id === "second:ruhr-7:laneMasks:1");
    expect(arrow.adopted).toBe(true);
    expect(arrow.firstCrossReview.asphaltOnlyCoverage).toBe(false);
    expect(arrow.secondAdjudication.decision).toBe("reject");
  });

  it("keeps contaminated and incomplete global lane correspondence unscorable", () => {
    const frames = read("development-references.json") as ReferenceFrame[];
    for (const id of ["north-5", "brandenburg-8", "north-6", "central-11", "thuringia-15"])
      expect(frames.find((f) => f.id === id)?.truth).toBeUndefined();
    const result = scoreFrames(
      frames,
      frames.map((f) => ({ id: f.id, photoShown: false, ribbons: [] })),
    );
    expect(result).toMatchObject({ positives: 0, usefulness: 0, accepted: 0, unscorable: 5 });
  });

  it("scores the archived construction scene without inventing a backward-scene layout", () => {
    const frames = read("development-references.json") as ReferenceFrame[];
    expect(frames.find((f) => f.id === "saar-10")?.truth?.laneCount).toBe(2);
    expect(frames.find((f) => f.id === "palatinate-10")?.truth?.laneCount).toBe(0);
    expect(
      scoreFrames(
        frames,
        frames.map((f) => ({
          id: f.id,
          photoShown: f.id === "saar-10",
          ribbons: [],
        })),
      ).wrongScene,
    ).toBe(1);
  });
});
