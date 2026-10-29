/** Creator fields in a Panoramax STAC Feature, shared by photo adapters. */
export interface PanoramaxCreatorMetadata {
  readonly providers?: readonly {
    readonly name?: string;
    readonly roles?: readonly string[];
  }[];
  readonly properties?: {
    readonly "geovisio:producer"?: string;
  };
}

/** Credit the producing account, never a host or distributor entry. */
export function panoramaxAuthor(item: PanoramaxCreatorMetadata): string | undefined {
  const producer = item.providers?.find((provider) => provider.roles?.includes("producer"));
  return producer?.name?.trim() || item.properties?.["geovisio:producer"]?.trim() || undefined;
}
