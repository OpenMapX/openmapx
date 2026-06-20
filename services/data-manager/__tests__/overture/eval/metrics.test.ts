import { describe, expect, it } from "vitest";
import { computeMetrics, SWEEP_GRID } from "../../../src/jobs/overture/eval/metrics.js";

describe("computeMetrics", () => {
  it("all correct predictions → precision=1, recall=1, f1=1", () => {
    const labels = [true, true, false, false, true];
    const preds = [true, true, false, false, true];
    const result = computeMetrics(labels, preds);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.tp).toBe(3);
    expect(result.fp).toBe(0);
    expect(result.fn).toBe(0);
  });

  it("all false positives → precision=0, recall=0, f1=0", () => {
    const labels = [false, false, false];
    const preds = [true, true, true];
    const result = computeMetrics(labels, preds);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
    expect(result.tp).toBe(0);
    expect(result.fp).toBe(3);
    expect(result.fn).toBe(0);
  });

  it("mixed results → known tp/fp/fn counts and correct precision/recall/f1", () => {
    // tp=2, fp=1, fn=1
    // precision = 2/(2+1) = 2/3
    // recall = 2/(2+1) = 2/3
    // f1 = 2*(2/3)*(2/3) / (2/3+2/3) = 2/3
    const labels = [true, true, false, true];
    const preds = [true, true, true, false];
    const result = computeMetrics(labels, preds);
    expect(result.tp).toBe(2);
    expect(result.fp).toBe(1);
    expect(result.fn).toBe(1);
    expect(result.precision).toBeCloseTo(2 / 3, 5);
    expect(result.recall).toBeCloseTo(2 / 3, 5);
    expect(result.f1).toBeCloseTo(2 / 3, 5);
  });

  it("all false negatives → precision=0 (no predictions), recall=0, f1=0", () => {
    const labels = [true, true, true];
    const preds = [false, false, false];
    const result = computeMetrics(labels, preds);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
    expect(result.tp).toBe(0);
    expect(result.fp).toBe(0);
    expect(result.fn).toBe(3);
  });

  it("throws when labels and predictions have different lengths", () => {
    expect(() => computeMetrics([true, false], [true])).toThrow();
  });
});

describe("SWEEP_GRID", () => {
  it("has exactly 54 cells (3 × 3 × 3 × 2)", () => {
    expect(SWEEP_GRID.length).toBe(54);
  });

  it("contains all expected alwaysMergeM values", () => {
    const values = new Set(SWEEP_GRID.map((c) => c.alwaysMergeM));
    expect([...values].sort((a, b) => a - b)).toEqual([20, 25, 30]);
  });

  it("contains all expected softWindowM values", () => {
    const values = new Set(SWEEP_GRID.map((c) => c.softWindowM));
    expect([...values].sort((a, b) => a - b)).toEqual([100, 120, 150]);
  });

  it("contains all expected nameDiceFloor values", () => {
    const values = new Set(SWEEP_GRID.map((c) => c.nameDiceFloor));
    expect([...values].sort((a, b) => a - b)).toEqual([0.75, 0.8, 0.85]);
  });

  it("contains all expected confidenceFloor values", () => {
    const values = new Set(SWEEP_GRID.map((c) => c.confidenceFloor));
    expect([...values].sort((a, b) => a - b)).toEqual([0.5, 0.7]);
  });

  it("every cell has the required shape", () => {
    for (const cell of SWEEP_GRID) {
      expect(typeof cell.alwaysMergeM).toBe("number");
      expect(typeof cell.softWindowM).toBe("number");
      expect(typeof cell.nameDiceFloor).toBe("number");
      expect(typeof cell.confidenceFloor).toBe("number");
    }
  });
});
