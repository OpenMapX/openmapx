export interface MetricsResult {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

export function computeMetrics(labels: boolean[], predictions: boolean[]): MetricsResult {
  if (labels.length !== predictions.length) {
    throw new Error("labels and predictions must have the same length");
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < labels.length; i++) {
    if (predictions[i] && labels[i]) tp++;
    else if (predictions[i] && !labels[i]) fp++;
    else if (!predictions[i] && labels[i]) fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
}

export interface SweepCell {
  alwaysMergeM: number;
  softWindowM: number;
  nameDiceFloor: number;
  confidenceFloor: number;
}

export const SWEEP_GRID: SweepCell[] = [];
for (const alwaysMergeM of [20, 25, 30]) {
  for (const softWindowM of [100, 120, 150]) {
    for (const nameDiceFloor of [0.75, 0.8, 0.85]) {
      for (const confidenceFloor of [0.5, 0.7]) {
        SWEEP_GRID.push({ alwaysMergeM, softWindowM, nameDiceFloor, confidenceFloor });
      }
    }
  }
}
