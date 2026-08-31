/** Owner-facing projection of a share link — never contains the token or its hash. */
export interface OwnerShare {
  id: string;
  targetType: "list" | "route";
  targetId: string | null;
  mode: "live" | "snapshot";
  label: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface RouteShareWaypoint {
  lat: number;
  lng: number;
  label?: string;
}

/** The stored route-share inputs; viewers re-request the route from these. */
export interface RouteSharePayload {
  waypoints: RouteShareWaypoint[];
  mode: "driving" | "walking" | "cycling" | "motorcycle";
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
}

export interface PublicSharePlace {
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  note?: string | null;
  placeId?: string | null;
}

export interface PublicListShare {
  type: "list";
  mode: "live" | "snapshot";
  name: string;
  icon: string | null;
  places: PublicSharePlace[];
}

export interface PublicRouteShare {
  type: "route";
  mode: "snapshot";
  route: RouteSharePayload;
}

export type PublicShare = PublicListShare | PublicRouteShare;

export type CreateShareInput =
  | { targetType: "list"; targetId: string; mode: "live" | "snapshot"; expiresInDays?: number }
  | { targetType: "route"; route: RouteSharePayload; expiresInDays?: number };
