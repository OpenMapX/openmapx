import { createOverlayStore } from "@openmapx/core";

export type SchematicNetwork = "tram" | "subway-lightrail" | "rail-commuter" | "rail";
export type SchematicLayout = "geo" | "octi" | "orthorad";

export const SCHEMATIC_NETWORKS: { id: SchematicNetwork; labelKey: string }[] = [
  { id: "tram", labelKey: "network.tram" },
  { id: "subway-lightrail", labelKey: "network.subwayLightrail" },
  { id: "rail-commuter", labelKey: "network.railCommuter" },
  { id: "rail", labelKey: "network.rail" },
];

export const SCHEMATIC_LAYOUTS: { id: SchematicLayout; labelKey: string }[] = [
  { id: "geo", labelKey: "layout.geo" },
  { id: "octi", labelKey: "layout.octi" },
  { id: "orthorad", labelKey: "layout.orthorad" },
];

export const useSchematicTransitStore = createOverlayStore({
  overlayId: "schematic-transit",
  extra: {
    network: "subway-lightrail" as SchematicNetwork,
    layout: "octi" as SchematicLayout,
  },
  actions: (set) => ({
    setNetwork: (network: SchematicNetwork) => set({ network }),
    setLayout: (layout: SchematicLayout) => set({ layout }),
  }),
  onClose: () => ({
    network: "subway-lightrail" as SchematicNetwork,
    layout: "octi" as SchematicLayout,
  }),
});
