import { createOverlayStore } from "@openmapx/core";

export type GibsLayerId =
  | "trueColor"
  | "trueColorViirs"
  | "nightLights"
  | "vegetation"
  | "snowCover"
  | "seaSurfaceTemp"
  | "aerosol";

export interface GibsLayerDef {
  id: GibsLayerId;
  identifier: string;
  tileMatrixSet: string;
  format: "jpg" | "png";
  maxZoom: number;
  labelKey: string;
}

export interface LayerCapability {
  defaultDate: string;
  startDate: string;
  legend?: string;
}

export type Capabilities = Record<string, LayerCapability>;

export const GIBS_LAYERS: GibsLayerDef[] = [
  {
    id: "trueColor",
    identifier: "MODIS_Terra_CorrectedReflectance_TrueColor",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxZoom: 9,
    labelKey: "trueColor",
  },
  {
    id: "trueColorViirs",
    identifier: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxZoom: 9,
    labelKey: "trueColorViirs",
  },
  {
    id: "nightLights",
    identifier: "VIIRS_SNPP_DayNightBand_AtSensor_M15",
    tileMatrixSet: "GoogleMapsCompatible_Level8",
    format: "png",
    maxZoom: 8,
    labelKey: "nightLights",
  },
  {
    id: "vegetation",
    identifier: "MODIS_Terra_NDVI_8Day",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "png",
    maxZoom: 9,
    labelKey: "vegetation",
  },
  {
    id: "snowCover",
    identifier: "MODIS_Terra_NDSI_Snow_Cover",
    tileMatrixSet: "GoogleMapsCompatible_Level8",
    format: "png",
    maxZoom: 8,
    labelKey: "snowCover",
  },
  {
    id: "seaSurfaceTemp",
    identifier: "GHRSST_L4_MUR_Sea_Surface_Temperature",
    tileMatrixSet: "GoogleMapsCompatible_Level7",
    format: "png",
    maxZoom: 7,
    labelKey: "seaSurfaceTemp",
  },
  {
    id: "aerosol",
    identifier: "MODIS_Terra_Aerosol_Optical_Depth_3km",
    tileMatrixSet: "GoogleMapsCompatible_Level6",
    format: "png",
    maxZoom: 6,
    labelKey: "aerosol",
  },
];

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

export const useSatelliteStore = createOverlayStore({
  overlayId: "satellite",
  extra: {
    activeLayer: "trueColor" as GibsLayerId,
    date: today(),
    opacity: 0.85,
    loading: false,
    capabilities: null as Capabilities | null,
  },
  actions: (set) => ({
    setActiveLayer: (layer: GibsLayerId) => set({ activeLayer: layer }),
    setDate: (date: string) => set({ date }),
    setOpacity: (opacity: number) => set({ opacity }),
    setLoading: (loading: boolean) => set({ loading }),
    setCapabilities: (capabilities: Capabilities | null) => set({ capabilities }),
  }),
  onClose: () => ({
    activeLayer: "trueColor" as GibsLayerId,
    date: today(),
    opacity: 0.85,
    loading: false,
    capabilities: null as Capabilities | null,
  }),
});
