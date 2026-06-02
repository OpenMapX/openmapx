/** Estimated arrival epoch (ms) given seconds remaining and the current time. */
export function eta(durationRemainingSec: number, nowMs: number): number {
  return nowMs + durationRemainingSec * 1000;
}
