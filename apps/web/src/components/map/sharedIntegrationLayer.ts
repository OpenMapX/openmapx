interface SharedLayerCandidate {
  id: string;
  frontend?: { sharedMapLayer?: string };
}

/**
 * Collapse integrations that share one frontend component down to a single
 * entry. Several providers can back one overlay (street-level imagery is served
 * by Panoramax, Mapillary and others through one coverage layer and one
 * legend); mounting the component once per integration would collide on every
 * MapLibre layer id and stack duplicate legends over the same store.
 * The first integration in registry order wins, so provider priority decides
 * which module actually loads.
 */
export function dedupeSharedMapLayers<T extends SharedLayerCandidate>(integrations: T[]): T[] {
  const seenSharedKeys = new Set<string>();
  const result: T[] = [];

  for (const integration of integrations) {
    const sharedKey = integration.frontend?.sharedMapLayer;
    if (!sharedKey) {
      result.push(integration);
      continue;
    }
    if (seenSharedKeys.has(sharedKey)) continue;
    seenSharedKeys.add(sharedKey);
    result.push(integration);
  }
  return result;
}
