import type { SxProps, Theme } from "@mui/material/styles";
import type { ComponentType } from "react";
import { lazy } from "react";

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
const PlaceDetailCard = lazy(() =>
  import("./place/PlaceDetailCard").then((m) => ({ default: m.PlaceDetailCard })),
);

interface PanelEntry {
  component: ComponentType;
  contentSx?: SxProps<Theme>;
}

export const SIDEBAR_PANELS: Record<string, PanelEntry> = {
  place: { component: PlacePanelContent },
  category: { component: CategoryResultsContent },
  datasource: { component: DataSourceFilterContent },
  directions: { component: DirectionsPanelContent },
  saved: { component: SavedPlacesContent, contentSx: { pt: { xs: 0, sm: "72px" } } },
};

export const DETAIL_PANELS: Record<string, ComponentType> = {
  "place-card": PlaceDetailCard,
};
