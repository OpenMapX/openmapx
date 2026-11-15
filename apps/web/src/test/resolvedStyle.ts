// jsdom resolves computed styles the way a browser does: var() references are
// substituted (with the globals.css tokens setup.ts installs) and lengths and
// colours come back resolved, e.g. `calc(12px + var(--omx-safe-bottom))` reads
// as `12px`. Asserting a computed style against the authored expression would
// therefore never match. This resolves an authored value through the same
// cascade so a test can keep naming the token or layout constant it expects.
export function resolvedStyle(property: string, value: string): string {
  const probe = document.createElement("div");
  // Positioned, so inset properties resolve to lengths rather than `auto`.
  probe.style.position = "absolute";
  probe.style.setProperty(property, value);
  if (!probe.style.getPropertyValue(property)) {
    throw new Error(`resolvedStyle: ${property}: ${value} is not a valid declaration`);
  }
  document.body.append(probe);
  try {
    return getComputedStyle(probe).getPropertyValue(property);
  } finally {
    probe.remove();
  }
}
