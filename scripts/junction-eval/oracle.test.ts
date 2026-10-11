import { describe, expect, it } from "vitest";
import { scoreFrames, validateCorpus } from "./oracle";

const square = (left: number, right: number) =>
  [
    [left, 0],
    [right, 0],
    [right, 100],
    [left, 100],
  ] as [number, number][];

const reference = {
  id: "control-01",
  site: "site-01",
  sequence: "sequence-01",
  region: "region-01",
  split: "development" as const,
  source: "synthetic" as const,
  collectedAt: "2026-10-11T00:00:00Z",
  revision: "a".repeat(40),
  evidenceHash: "b".repeat(64),
  categories: ["two-lane", "left-exit"],
  photo: {
    id: "image-01",
    hash: "c".repeat(64),
    license: "CC-BY-SA-4.0",
    width: 100,
    height: 100,
  },
  truth: {
    certainty: "certain" as const,
    reviewers: ["reviewer-01", "reviewer-02"],
    evidence: "Hand-traced two travel lanes; shoulder excluded.",
    photoRelevant: true,
    clearMarkedSupported: true,
    preferredLanes: [0],
    laneCount: 2,
    signSpans: [[0], [1]],
    travelLanes: [square(10, 45), square(50, 85)],
    forbidden: [square(90, 100)],
  },
};

describe("junction reference oracle", () => {
  it("accepts independently reviewed, contiguous reference evidence", () => {
    expect(validateCorpus([reference])).toEqual([]);
  });

  it("rejects site and capture-sequence leakage across splits", () => {
    const errors = validateCorpus([
      reference,
      { ...reference, id: "control-02", split: "holdout" },
    ]);
    expect(errors).toContain("site-01: site crosses splits");
    expect(errors).toContain("sequence-01: sequence crosses splits");
  });

  it("rejects missing media rights and impossible lane spans", () => {
    const errors = validateCorpus([
      {
        ...reference,
        photo: { ...reference.photo, license: "", hash: "" },
        truth: { ...reference.truth, signSpans: [[0, 2]], preferredLanes: [2] },
      },
    ]);
    expect(errors).toContain("control-01: photo hash or license missing");
    expect(errors).toContain("control-01: lane index outside layout");
    expect(errors).toContain("control-01: sign span is not contiguous");
  });

  it("scores a known wrong scene without inventing a photographed lane count", () => {
    const negative = {
      ...reference,
      truth: {
        ...reference.truth,
        photoRelevant: false,
        clearMarkedSupported: false,
        laneCount: 0,
        preferredLanes: [],
        signSpans: [],
        travelLanes: [],
        forbidden: [],
      },
    };
    expect(validateCorpus([negative])).toEqual([]);
    expect(
      scoreFrames([negative], [{ id: negative.id, photoShown: true, ribbons: [] }]).wrongScene,
    ).toBe(1);
    expect(
      validateCorpus([{ ...negative, truth: { ...negative.truth, photoRelevant: true } }]),
    ).toContain("control-01: lane index outside layout");
  });

  it("does not certify a single annotation or an uncertain target", () => {
    expect(
      validateCorpus([{ ...reference, truth: { ...reference.truth, reviewers: ["reviewer-01"] } }]),
    ).toContain("control-01: certain truth requires independent reviewers");
    expect(
      validateCorpus([
        {
          ...reference,
          truth: { ...reference.truth, certainty: "uncertain", clearMarkedSupported: true },
        },
      ]),
    ).toContain("control-01: uncertain truth cannot be a supported positive");
  });

  it("scores a correctly contained ribbon independently of the fitter", () => {
    const result = scoreFrames(
      [reference],
      [{ id: reference.id, photoShown: true, ribbons: [{ lane: 0, polygon: square(20, 30) }] }],
    );
    expect(result.wrongLane).toBe(0);
    expect(result.accepted).toBe(1);
    expect(result.usefulness).toBe(1);
  });

  it.each([
    [
      [20, 50],
      [20, 50],
      [20, 50],
    ],
    [
      [20, 20],
      [25, 50],
      [30, 80],
    ],
  ] as [number, number][][])("rejects invisible zero-area ribbons: %j", (...polygon) => {
    const result = scoreFrames(
      [reference],
      [{ id: reference.id, photoShown: true, ribbons: [{ lane: 0, polygon }] }],
    );
    expect(result.accepted).toBe(0);
    expect(result.usefulness).toBe(0);
    expect(result.wrongLane).toBe(1);
  });

  it.each(["travelLanes", "forbidden"] as const)(
    "rejects zero-area %s reference masks",
    (field) => {
      expect(
        validateCorpus([
          {
            ...reference,
            truth: {
              ...reference.truth,
              [field]: [
                [
                  [20, 50],
                  [20, 50],
                  [20, 50],
                ],
              ],
            },
          },
        ]),
      ).toContain("control-01: invalid pixel mask");
    },
  );

  it("rejects a filled polygon that crosses another lane despite a correct center", () => {
    const result = scoreFrames(
      [reference],
      [{ id: reference.id, photoShown: true, ribbons: [{ lane: 0, polygon: square(20, 70) }] }],
    );
    expect(result.wrongLane).toBe(1);
    expect(result.accepted).toBe(0);
  });

  it("a reject-all pipeline earns zero usefulness", () => {
    expect(
      scoreFrames([reference], [{ id: reference.id, photoShown: false, ribbons: [] }]).usefulness,
    ).toBe(0);
  });

  it("accepts separate visible fragments of the same lane without filling the gap", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        clearMarkedSupported: false,
        maskScope: "visible-fragments" as const,
        travelLanes: [],
        travelLaneFragments: [
          { lane: 0, polygon: square(10, 30) },
          { lane: 0, polygon: square(60, 80) },
        ],
      },
    };
    const result = scoreFrames(
      [frame],
      [
        {
          id: frame.id,
          photoShown: true,
          ribbons: [
            { lane: 0, polygon: square(15, 25) },
            { lane: 0, polygon: square(65, 75) },
          ],
        },
      ],
    );
    expect(validateCorpus([frame])).toEqual([]);
    expect(result.accepted).toBe(1);
    expect(result.usefulness).toBe(0);
  });

  it("leaves an unlabelled gap between valid fragments unscorable", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        travelLanes: [],
        clearMarkedSupported: false,
        maskScope: "visible-fragments" as const,
        travelLaneFragments: [
          { lane: 0, polygon: square(10, 30) },
          { lane: 0, polygon: square(60, 80) },
        ],
      },
    };
    const result = scoreFrames(
      [frame],
      [{ id: frame.id, photoShown: true, ribbons: [{ lane: 0, polygon: square(20, 70) }] }],
    );
    expect(result.wrongLane).toBe(0);
    expect(result.accepted).toBe(0);
    expect(result.unscorable).toBe(1);
  });

  it.each(["other-lane", "forbidden", "invalid-shape", "wrong-index"])(
    "still rejects known %s failures with partial masks",
    (failure) => {
      const frame = {
        ...reference,
        truth: {
          ...reference.truth,
          travelLanes: [],
          clearMarkedSupported: false,
          maskScope: "visible-fragments" as const,
          travelLaneFragments: [
            { lane: 0, polygon: square(10, 30) },
            { lane: 1, polygon: square(60, 80) },
          ],
        },
      };
      const polygon =
        failure === "forbidden"
          ? square(95, 99)
          : failure === "invalid-shape"
            ? ([
                [20, 50],
                [20, 50],
                [20, 50],
              ] as [number, number][])
            : failure === "other-lane"
              ? square(65, 75)
              : square(15, 25);
      const result = scoreFrames(
        [frame],
        [
          {
            id: frame.id,
            photoShown: true,
            ribbons: [{ lane: failure === "wrong-index" ? 1 : 0, polygon }],
          },
        ],
      );
      expect(result.wrongLane).toBe(1);
      expect(result.unscorable).toBe(0);
      expect(result.accepted).toBe(0);
    },
  );

  it("validates fragment indices, area and source bounds", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        travelLaneFragments: [
          { lane: 2, polygon: square(15, 25) },
          {
            lane: 0,
            polygon: [
              [20, 20],
              [20, 20],
              [20, 20],
            ] as [number, number][],
          },
          { lane: 0, polygon: square(95, 105) },
        ],
      },
    };
    expect(validateCorpus([frame])).toContain("control-01: lane index outside layout");
    expect(validateCorpus([frame])).toContain("control-01: invalid pixel mask");
  });

  it("does not promote partial capture references to the complete-layout usefulness denominator", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        travelLanes: [],
        travelLaneFragments: [{ lane: 0, polygon: square(10, 30) }],
      },
    };
    expect(validateCorpus([frame])).toContain("control-01: supported positive lacks target masks");
  });

  it("requires fragment references to declare their partial scope", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        clearMarkedSupported: false,
        travelLaneFragments: [{ lane: 0, polygon: square(10, 30) }],
      },
    };
    expect(validateCorpus([frame])).toContain(
      "control-01: fragment truth requires visible-fragments scope",
    );
  });

  it("keeps fragment scope explicit even when every lane has a labelled patch", () => {
    const frame = {
      ...reference,
      truth: {
        ...reference.truth,
        maskScope: "visible-fragments" as const,
        travelLaneFragments: [
          { lane: 0, polygon: square(10, 30) },
          { lane: 1, polygon: square(60, 80) },
        ],
      },
    };
    expect(validateCorpus([frame])).toContain(
      "control-01: fragment truth cannot certify complete-layout usefulness",
    );
    expect(
      scoreFrames(
        [frame],
        [{ id: frame.id, photoShown: true, ribbons: [{ lane: 0, polygon: square(20, 25) }] }],
      ).positives,
    ).toBe(0);
  });
  it("does not count incomplete preferred-lane guidance as useful", () => {
    const result = scoreFrames(
      [{ ...reference, truth: { ...reference.truth, preferredLanes: [0, 1] } }],
      [{ id: reference.id, photoShown: true, ribbons: [{ lane: 0, polygon: square(20, 30) }] }],
    );
    expect(result.wrongLane).toBe(0);
    expect(result.usefulness).toBe(0);
  });

  it("counts an unrelated scene as a failure even without ribbons", () => {
    const result = scoreFrames(
      [
        {
          ...reference,
          truth: { ...reference.truth, photoRelevant: false, clearMarkedSupported: false },
        },
      ],
      [{ id: reference.id, photoShown: true, ribbons: [] }],
    );
    expect(result.wrongScene).toBe(1);
  });
});
