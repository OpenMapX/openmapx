"use client";

import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DirectionsIcon from "@mui/icons-material/Directions";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExploreIcon from "@mui/icons-material/Explore";
import Grid4x4Icon from "@mui/icons-material/Grid4x4";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlined";
import LayersIcon from "@mui/icons-material/Layers";
import LightModeIcon from "@mui/icons-material/LightMode";
import LinkIcon from "@mui/icons-material/Link";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import MapIcon from "@mui/icons-material/Map";
import MenuIcon from "@mui/icons-material/Menu";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import NavigationIcon from "@mui/icons-material/Navigation";
import NearMeIcon from "@mui/icons-material/NearMe";
import PublicIcon from "@mui/icons-material/Public";
import RestaurantIcon from "@mui/icons-material/Restaurant";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import SearchIcon from "@mui/icons-material/Search";
import TerrainIcon from "@mui/icons-material/Terrain";
import TranslateIcon from "@mui/icons-material/Translate";
import type { ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  layer: <LayersIcon fontSize="small" />,
  "layer-default": <MapIcon fontSize="small" />,
  "layer-satellite": <SatelliteAltIcon fontSize="small" />,
  "layer-terrain": <TerrainIcon fontSize="small" />,
  "layer-cycling": <ExploreIcon fontSize="small" />,
  globe: <PublicIcon fontSize="small" />,
  overlay: <LayersIcon fontSize="small" />,
  panel: <NearMeIcon fontSize="small" />,
  saved: <BookmarkBorderIcon fontSize="small" />,
  parking: <LocalParkingIcon fontSize="small" />,
  directions: <DirectionsIcon fontSize="small" />,
  nearby: <NearMeIcon fontSize="small" />,
  menu: <MenuIcon fontSize="small" />,
  category: <RestaurantIcon fontSize="small" />,
  search: <SearchIcon fontSize="small" />,
  share: (
    <LinkIcon
      sx={{
        fontSize: "small",
      }}
    />
  ),
  theme: <LightModeIcon fontSize="small" />,
  language: <TranslateIcon fontSize="small" />,
  "my-location": <MyLocationIcon fontSize="small" />,
  "align-streets": <Grid4x4Icon fontSize="small" />,
  "north-up": <NavigationIcon fontSize="small" />,
  help: <HelpOutlineIcon fontSize="small" />,
  expand: <ExpandMoreIcon fontSize="small" />,
};

export function commandIcon(iconKey: string): ReactNode {
  return ICONS[iconKey] ?? <SearchIcon fontSize="small" />;
}
