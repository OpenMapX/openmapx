import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { create } from "zustand";
import type {
  TransitAccessMode,
  TransitPreferKey,
  TransitRoutePreference,
} from "../constants/transit";
import { getStorage } from "../platform/storage";
import type { LngLat } from "../types/geometry";
import type { TravelMode, Waypoint, WaypointSchedule } from "../types/routing";

// Route-avoidance defaults persist so a chosen preference (also editable in the
// nav settings screen) applies to every route rather than resetting each session.
const AVOID_HIGHWAYS_STORAGE_KEY = "openmapx:avoidHighways";
const AVOID_TOLLS_STORAGE_KEY = "openmapx:avoidTolls";
const AVOID_FERRIES_STORAGE_KEY = "openmapx:avoidFerries";

function readBool(key: string): boolean {
  return getStorage().getString(key) === "true";
}

let waypointCounter = 0;
function newWaypointId(): string {
  return `wp_${++waypointCounter}_${Date.now()}`;
}

function deriveTypes(wps: Waypoint[]): Waypoint[] {
  return wps.map((wp, i) => ({
    ...wp,
    type: i === 0 ? "origin" : i === wps.length - 1 ? "destination" : "waypoint",
  }));
}

function makeEmptyWaypoint(): Waypoint {
  return { id: newWaypointId(), coords: null, label: "", type: "waypoint" };
}

const MAX_WAYPOINTS = 10;

function hasWindow(schedule: WaypointSchedule | undefined): boolean {
  return (
    schedule !== undefined &&
    (schedule.departAfter !== undefined ||
      schedule.arriveBy !== undefined ||
      schedule.fixedAt !== undefined)
  );
}

export interface DirectionsState {
  isOpen: boolean;
  waypoints: Waypoint[];
  /**
   * Active travel mode. ROUTING BOUNDARY: `driving`/`walking`/`cycling` are
   * served by the street-routing orchestrator (`integrations/routing/*` →
   * OSRM/Valhalla); `transit` is served by the transit orchestrator
   * (`integrations/transit/*` → MOTIS). These paths share no code or types.
   * MOTIS street routing must only ever reach the app inside transit
   * `TripLeg` access legs (intermodal first/last-mile) — never wire MOTIS into
   * the `/directions` chain.
   */
  mode: TravelMode;
  /**
   * EV trip-planning mode. Deliberately NOT folded into `mode` — `"ev"` is not
   * a `TravelMode` (that would ripple through the transit/flying guards in
   * `parseTravelMode` and every routing engine). Toggling EV mode leaves
   * `mode` at `"driving"` so the map/base plumbing still sees a driving route;
   * `DirectionsPanelContent` branches on `isEvMode` to swap in the EV panel
   * and call `useEvDirections` instead of `useDirections`.
   */
  isEvMode: boolean;
  /**
   * Trip-level time selection, shared by the ground and transit flows. It lives
   * here rather than in the panel because the map's independent directions
   * query has to build the same request — otherwise the two split the cache and
   * draw different routes.
   */
  timeMode: "now" | "depart" | "arrive";
  tripTime: Date | null;
  /** Transient (not persisted) current battery state of charge, 0–100. */
  evSocStartPct: number;
  /** Transient (not persisted) minimum arrival-reserve state of charge, 0–100. */
  evSocArrivalMinPct: number;
  /**
   * Transient one-shot override for the "no-allowed-network" recovery
   * action ("route without the network restriction") — forces the next EV
   * request's `exclusiveNetworks` to `false` regardless of the persisted
   * setting. Lives here (not component state) so the panel's plan card and
   * the map's independent `useEvDirections` query (RouteLayer) stay in sync.
   */
  evForceNonExclusive: boolean;
  activeRouteIndex: number;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  transitItineraries: TripItinerary[];
  activeItineraryIndex: number;
  transitDepartureTime: "now" | Date;
  transitArrivalTime: Date | null;
  /** "Prefer" column: transit modes to allow-list (empty = all modes). */
  transitPreferredModes: TransitPreferKey[];
  /** "Routes" column: single-select route optimisation. */
  transitRoutePreference: TransitRoutePreference;
  /** First/last-mile access mode for intermodal transit (walk/bike/car). */
  transitAccessMode: TransitAccessMode;
  wheelchairRequired: boolean;
  maxTransfers: number | null;
  transferBuffer: "standard" | "relaxed" | "extra";
  requireBikeTransport: boolean;
  bikeHillPreference: "default" | "avoid" | "strongly-avoid";
  /** Germany-only: restrict transit to Deutschlandticket-covered services. */
  deutschlandticketOnly: boolean;

  // Actions
  open: () => void;
  close: () => void;
  setWaypoint: (index: number, coords: LngLat | null, label: string) => void;
  addWaypoint: (afterIndex: number) => void;
  removeWaypoint: (index: number) => void;
  reorderWaypoints: (fromIndex: number, toIndex: number) => void;
  reverseWaypoints: () => void;
  setMode: (mode: TravelMode) => void;
  /** Toggle EV trip-planning mode. Turning it on forces `mode` back to `"driving"`. */
  setEvMode: (on: boolean) => void;
  setTimeMode: (mode: "now" | "depart" | "arrive") => void;
  setTripTime: (t: Date | null) => void;
  /** `null` clears the waypoint's constraints entirely. */
  setWaypointSchedule: (index: number, schedule: WaypointSchedule | null) => void;
  /**
   * Reorder waypoints by original index, moving each waypoint object whole so
   * its schedule travels with it. Returns false — leaving the order untouched —
   * when a time window is set, because reordering could break an appointment.
   */
  applyWaypointOrder: (order: number[]) => boolean;
  /** Any waypoint carries `departAfter`, `arriveBy` or `fixedAt`. */
  hasScheduleConstraints: () => boolean;
  setEvSocStartPct: (v: number) => void;
  setEvSocArrivalMinPct: (v: number) => void;
  setEvForceNonExclusive: (v: boolean) => void;
  setActiveRouteIndex: (index: number) => void;
  setAvoidHighways: (v: boolean) => void;
  setAvoidTolls: (v: boolean) => void;
  setAvoidFerries: (v: boolean) => void;
  /** Re-read the persisted route-avoidance defaults (storage may configure late). */
  hydrateRoutePrefs: () => void;
  setTransitItineraries: (items: TripItinerary[]) => void;
  setActiveItineraryIndex: (i: number) => void;
  setTransitDepartureTime: (t: "now" | Date) => void;
  setTransitArrivalTime: (t: Date | null) => void;
  toggleTransitPreferredMode: (key: TransitPreferKey) => void;
  setTransitRoutePreference: (p: TransitRoutePreference) => void;
  setTransitAccessMode: (m: TransitAccessMode) => void;
  setWheelchairRequired: (v: boolean) => void;
  setMaxTransfers: (v: number | null) => void;
  setTransferBuffer: (v: "standard" | "relaxed" | "extra") => void;
  setRequireBikeTransport: (v: boolean) => void;
  setBikeHillPreference: (v: "default" | "avoid" | "strongly-avoid") => void;
  setDeutschlandticketOnly: (v: boolean) => void;
}

function initialWaypoints(): Waypoint[] {
  return deriveTypes([
    { id: newWaypointId(), coords: null, label: "", type: "origin" },
    { id: newWaypointId(), coords: null, label: "", type: "destination" },
  ]);
}

export const useDirectionsStore = create<DirectionsState>((set, get) => {
  const initWps = initialWaypoints();
  return {
    isOpen: false,
    waypoints: initWps,
    mode: "driving",
    isEvMode: false,
    timeMode: "now" as const,
    tripTime: null,
    evSocStartPct: 80,
    evSocArrivalMinPct: 10,
    evForceNonExclusive: false,
    activeRouteIndex: 0,
    avoidHighways: readBool(AVOID_HIGHWAYS_STORAGE_KEY),
    avoidTolls: readBool(AVOID_TOLLS_STORAGE_KEY),
    avoidFerries: readBool(AVOID_FERRIES_STORAGE_KEY),
    transitItineraries: [],
    activeItineraryIndex: 0,
    transitDepartureTime: "now" as const,
    transitArrivalTime: null,
    transitPreferredModes: [],
    transitRoutePreference: "best" as const,
    transitAccessMode: "walk" as const,
    wheelchairRequired: false,
    maxTransfers: null,
    transferBuffer: "standard" as const,
    requireBikeTransport: false,
    bikeHillPreference: "default" as const,
    deutschlandticketOnly: false,

    open: () => set({ isOpen: true }),
    close: () => {
      const wps = initialWaypoints();
      set({
        isOpen: false,
        waypoints: wps,
        activeRouteIndex: 0,
        isEvMode: false,
        timeMode: "now" as const,
        tripTime: null,
        evSocStartPct: 80,
        evSocArrivalMinPct: 10,
        evForceNonExclusive: false,
        transitItineraries: [],
        activeItineraryIndex: 0,
        transitDepartureTime: "now" as const,
        transitArrivalTime: null,
        transitPreferredModes: [],
        transitRoutePreference: "best" as const,
        transitAccessMode: "walk" as const,
        wheelchairRequired: false,
        maxTransfers: null,
        transferBuffer: "standard" as const,
        requireBikeTransport: false,
        bikeHillPreference: "default" as const,
        deutschlandticketOnly: false,
      });
    },

    setWaypoint: (index, coords, label) => {
      const wps = [...get().waypoints];
      if (index < 0 || index >= wps.length) return;
      wps[index] = { ...wps[index], coords, label };
      set({ waypoints: wps, activeRouteIndex: 0 });
    },

    addWaypoint: (afterIndex) => {
      const wps = [...get().waypoints];
      if (wps.length >= MAX_WAYPOINTS) return;
      const newWp = makeEmptyWaypoint();
      wps.splice(afterIndex + 1, 0, newWp);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, activeRouteIndex: 0 });
    },

    removeWaypoint: (index) => {
      const wps = [...get().waypoints];
      if (wps.length <= 2) return;
      wps.splice(index, 1);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, activeRouteIndex: 0 });
    },

    reorderWaypoints: (fromIndex, toIndex) => {
      const wps = [...get().waypoints];
      const [moved] = wps.splice(fromIndex, 1);
      wps.splice(toIndex, 0, moved);
      const typed = deriveTypes(wps);
      set({ waypoints: typed, activeRouteIndex: 0 });
    },

    reverseWaypoints: () => {
      const wps = [...get().waypoints].reverse();
      const typed = deriveTypes(wps);
      set({ waypoints: typed, activeRouteIndex: 0 });
    },

    setMode: (mode) => set({ mode, activeRouteIndex: 0, isEvMode: false }),
    setEvMode: (isEvMode) => {
      if (!isEvMode) {
        set({ isEvMode });
        return;
      }
      // EV re-routing only supports origin + destination (see ev-plan.ts) —
      // drop any intermediate waypoints picked up before switching into EV mode.
      const wps = get().waypoints;
      const last = wps.length - 1;
      const trimmed = last > 1 ? deriveTypes([wps[0], wps[last]]) : wps;
      set({
        waypoints: trimmed,
        isEvMode,
        mode: "driving",
        activeRouteIndex: 0,
        evForceNonExclusive: false,
      });
    },
    setEvSocStartPct: (evSocStartPct) => set({ evSocStartPct }),
    setEvSocArrivalMinPct: (evSocArrivalMinPct) => set({ evSocArrivalMinPct }),
    setEvForceNonExclusive: (evForceNonExclusive) => set({ evForceNonExclusive }),
    setTimeMode: (timeMode) =>
      set(timeMode === "now" ? { timeMode, tripTime: null } : { timeMode }),
    setTripTime: (tripTime) => set({ tripTime }),

    setWaypointSchedule: (index, schedule) => {
      const wps = get().waypoints;
      if (index < 0 || index >= wps.length) return;
      const next = [...wps];
      const { schedule: _previous, ...rest } = next[index];
      next[index] = schedule === null ? rest : { ...rest, schedule };
      set({ waypoints: next, activeRouteIndex: 0 });
    },

    applyWaypointOrder: (order) => {
      const wps = get().waypoints;
      if (order.length !== wps.length) return false;
      if (wps.some((wp) => hasWindow(wp.schedule))) return false;
      const reordered = order.map((index) => wps[index]);
      if (reordered.some((wp) => wp === undefined)) return false;
      set({ waypoints: deriveTypes(reordered), activeRouteIndex: 0 });
      return true;
    },

    hasScheduleConstraints: () => get().waypoints.some((wp) => hasWindow(wp.schedule)),

    setActiveRouteIndex: (activeRouteIndex) => set({ activeRouteIndex }),
    setAvoidHighways: (avoidHighways) => {
      getStorage().setString(AVOID_HIGHWAYS_STORAGE_KEY, String(avoidHighways));
      set({ avoidHighways });
    },
    setAvoidTolls: (avoidTolls) => {
      getStorage().setString(AVOID_TOLLS_STORAGE_KEY, String(avoidTolls));
      set({ avoidTolls });
    },
    setAvoidFerries: (avoidFerries) => {
      getStorage().setString(AVOID_FERRIES_STORAGE_KEY, String(avoidFerries));
      set({ avoidFerries });
    },
    hydrateRoutePrefs: () =>
      set({
        avoidHighways: readBool(AVOID_HIGHWAYS_STORAGE_KEY),
        avoidTolls: readBool(AVOID_TOLLS_STORAGE_KEY),
        avoidFerries: readBool(AVOID_FERRIES_STORAGE_KEY),
      }),
    setTransitItineraries: (transitItineraries) =>
      set({ transitItineraries, activeItineraryIndex: 0 }),
    setActiveItineraryIndex: (activeItineraryIndex) => set({ activeItineraryIndex }),
    setTransitDepartureTime: (transitDepartureTime) => set({ transitDepartureTime }),
    setTransitArrivalTime: (transitArrivalTime) => set({ transitArrivalTime }),
    toggleTransitPreferredMode: (key) => {
      const current = get().transitPreferredModes;
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      set({ transitPreferredModes: next, activeItineraryIndex: 0 });
    },
    setTransitRoutePreference: (transitRoutePreference) =>
      set({ transitRoutePreference, activeItineraryIndex: 0 }),
    setTransitAccessMode: (transitAccessMode) =>
      set({
        transitAccessMode,
        activeItineraryIndex: 0,
        ...(transitAccessMode !== "bike" ? { requireBikeTransport: false } : {}),
      }),
    setWheelchairRequired: (wheelchairRequired) =>
      set({ wheelchairRequired, activeItineraryIndex: 0 }),
    setMaxTransfers: (maxTransfers) => set({ maxTransfers, activeItineraryIndex: 0 }),
    setTransferBuffer: (transferBuffer) => set({ transferBuffer, activeItineraryIndex: 0 }),
    setRequireBikeTransport: (requireBikeTransport) =>
      set({ requireBikeTransport, activeItineraryIndex: 0 }),
    setBikeHillPreference: (bikeHillPreference) =>
      set({ bikeHillPreference, activeItineraryIndex: 0 }),
    setDeutschlandticketOnly: (deutschlandticketOnly) =>
      set({ deutschlandticketOnly, activeItineraryIndex: 0 }),
  };
});
