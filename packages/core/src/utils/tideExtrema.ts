export interface TideSample {
  time: string;
  value: number;
}

export interface TideExtreme {
  time: string;
  value: number;
  type: "H" | "L";
}

export interface TideExtremaOptions {
  /** Minimum swing (in the samples' own units) below which a reversal is noise. */
  minDelta: number;
  /** Extra threshold as a fraction of the series range, added via `max`. Default 0. */
  relativeDelta?: number;
}

/**
 * Derive tide highs/lows from a noisy observation series using hysteresis
 * (a "zigzag" peak detector). A reversal is only registered once the series
 * has moved at least `delta = max(minDelta, range * relativeDelta)` away from
 * the running peak/trough.
 *
 * This replaces a naive ±N-sample local-extremum scan, which on raw gauge data
 * reports dozens of spurious highs/lows — and, because it compared
 * non-strictly, flagged flat plateaus as both a high AND a low at the same
 * time. The hysteresis output is noise-free and strictly alternates H/L.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Drop spike/sentinel outliers from a gauge series: a sample is removed when it
 * deviates from the median of a centred ±`window` neighbourhood by more than
 * `maxDeviation` (in the samples' own units). Tide levels change slowly, so a
 * large jump over a few seconds is a sensor glitch (e.g. IOC's `-1.0` sentinel)
 * — and one such outlier wrecks both the range/threshold and the extrema. Run
 * this before {@link findTideExtrema} and before plotting the curve.
 */
export function despikeSeries(
  samples: TideSample[],
  maxDeviation: number,
  window = 5,
): TideSample[] {
  if (samples.length <= window * 2) return samples;
  const values = samples.map((s) => s.value);
  const kept: TideSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(values.length, i + window + 1);
    if (Math.abs(values[i] - median(values.slice(lo, hi))) <= maxDeviation) kept.push(samples[i]);
  }
  return kept;
}

export function findTideExtrema(samples: TideSample[], opts: TideExtremaOptions): TideExtreme[] {
  if (samples.length < 5) return [];

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (s.value < lo) lo = s.value;
    if (s.value > hi) hi = s.value;
  }
  const delta = Math.max(opts.minDelta, (hi - lo) * (opts.relativeDelta ?? 0));
  if (!(delta > 0)) return [];

  const extrema: TideExtreme[] = [];
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  let mnIdx = 0;
  let mxIdx = 0;
  // null until the first significant move decides whether to open on a high or low.
  let lookForMax: boolean | null = null;
  // Value of the last confirmed extreme, to gauge whether the trailing swing is real.
  let pivot: number | null = null;

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i].value;
    if (v > mx) {
      mx = v;
      mxIdx = i;
    }
    if (v < mn) {
      mn = v;
      mnIdx = i;
    }

    if (lookForMax !== false && v < mx - delta) {
      // Skip index 0: a drop from the first sample means the window opened past
      // a peak — a window edge, not a real turning point. Still transition.
      if (mxIdx > 0) {
        extrema.push({ time: samples[mxIdx].time, value: samples[mxIdx].value, type: "H" });
      }
      pivot = samples[mxIdx].value;
      mn = v;
      mnIdx = i;
      lookForMax = false;
    } else if (lookForMax !== true && v > mn + delta) {
      if (mnIdx > 0) {
        extrema.push({ time: samples[mnIdx].time, value: samples[mnIdx].value, type: "L" });
      }
      pivot = samples[mnIdx].value;
      mx = v;
      mxIdx = i;
      lookForMax = true;
    }
  }

  // Emit the final turning point. Hysteresis only confirms an extreme once the
  // series reverses past `delta`, so a peak/trough sitting at the very end of
  // the window (e.g. a recent high near "now") would otherwise be dropped.
  // Require it to be an actual turn (not the last sample) and ≥ delta from the
  // last pivot, so a still-rising/falling tail isn't reported as an extreme.
  const lastIdx = samples.length - 1;
  if (pivot !== null) {
    if (lookForMax && mxIdx < lastIdx && samples[mxIdx].value - pivot >= delta) {
      extrema.push({ time: samples[mxIdx].time, value: samples[mxIdx].value, type: "H" });
    } else if (lookForMax === false && mnIdx < lastIdx && pivot - samples[mnIdx].value >= delta) {
      extrema.push({ time: samples[mnIdx].time, value: samples[mnIdx].value, type: "L" });
    }
  }

  return extrema;
}
