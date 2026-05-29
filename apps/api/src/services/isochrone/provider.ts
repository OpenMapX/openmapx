// The isochrone data types are the canonical contract from
// `@openmapx/integration-framework`; re-exported here so the existing
// `services/isochrone/*` + route imports keep resolving. `IsochroneProvider`
// is the apps/api-internal provider contract (not part of the framework).
import type {
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
} from "@openmapx/integration-framework";

export type {
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
};

export interface IsochroneProvider {
  isochrone(
    origin: [number, number],
    mode: IsochroneTravelMode,
    contourMinutes: number[],
  ): Promise<IsochroneResult>;
}
