import type { ComponentType } from "react";
import { lazy } from "react";
import type { SearchBarClearance } from "./searchBarClearance";
import {
  type DetentConfig,
  DIRECTIONS_DETENTS,
  PARKING_DETENTS,
  PLACE_DETENTS,
} from "./sheet/detents";

const PlacePanelContent = lazy(() =>
  import("./place/PlacePanelContent").then((m) => ({ default: m.PlacePanelContent })),
);
const CategoryResultsContent = lazy(() =>
  import("./category/CategoryResultsContent").then((m) => ({
    default: m.CategoryResultsContent,
  })),
);
const DataSourceFilterContent = lazy(() =>
  import("./datasource/DataSourceFilterContent").then((m) => ({
    default: m.DataSourceFilterContent,
  })),
);
const DirectionsPanelContent = lazy(() =>
  import("./directions/DirectionsPanelContent").then((m) => ({
    default: m.DirectionsPanelContent,
  })),
);
const SavedPlacesContent = lazy(() =>
  import("./saved/SavedPlacesContent").then((m) => ({ default: m.SavedPlacesContent })),
);
const ParkingPanelContent = lazy(() =>
  import("./parking/ParkingPanelContent").then((m) => ({ default: m.ParkingPanelContent })),
);
const TimelinePanelContent = lazy(() =>
  import("./timeline/TimelinePanelContent").then((m) => ({ default: m.TimelinePanelContent })),
);
const PlaceDetailCard = lazy(() =>
  import("./place/PlaceDetailCard").then((m) => ({ default: m.PlaceDetailCard })),
);

interface PanelEntry {
  component: ComponentType;
  /** How the panel stays clear of the floating search bar. Falls back to "shell" in SidebarShell when unset. */
  searchBarClearance?: SearchBarClearance;
  /** Mobile sheet detents for this surface. Falls back to LIST_DETENTS in SidebarShell when unset. */
  detents?: DetentConfig;
}

export const SIDEBAR_PANELS: Record<string, PanelEntry> = {
  place: { component: PlacePanelContent, detents: PLACE_DETENTS, searchBarClearance: "content" },
  category: { component: CategoryResultsContent },
  datasource: { component: DataSourceFilterContent },
  directions: {
    component: DirectionsPanelContent,
    detents: DIRECTIONS_DETENTS,
    searchBarClearance: "none",
  },
  saved: { component: SavedPlacesContent },
  parking: { component: ParkingPanelContent, detents: PARKING_DETENTS },
  timeline: { component: TimelinePanelContent },
};

export const DETAIL_PANELS: Record<string, ComponentType> = {
  "place-card": PlaceDetailCard,
};
