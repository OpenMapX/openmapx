"use client";

import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { LngLat, PublicShare, PublicSharePlace, Route } from "@openmapx/core";
import {
  coordinateId,
  formatDistance,
  formatDuration,
  makeId,
  useDirections,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { SharedMapView } from "@/components/share/SharedMapView";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { buildDirectionsDeepLinkUrl, buildLocationShareUrl } from "@/lib/deepLink";
import { resolveListIcon } from "@/lib/listIcon";

/**
 * The deep-link builders return absolute URLs, but this component also renders
 * during SSR where `window` is undefined — so links are emitted relative and
 * resolve against whatever host serves the share page.
 */
function toRelative(absolute: string): string {
  const url = new URL(absolute);
  return `${url.pathname}${url.search}`;
}

function placeAppUrl(place: PublicSharePlace): string {
  const id =
    place.placeId ?? makeId("coordinate", { coordinate: coordinateId([place.lng, place.lat]) });
  return toRelative(
    buildLocationShareUrl("http://share.invalid/", {
      id,
      coordinates: [place.lng, place.lat],
      name: place.name,
    }),
  );
}

export function SharedViewClient({ share }: { share: PublicShare | null }) {
  const t = useTranslations("share");
  const tSaved = useTranslations("saved");
  const locale = useLocale();

  const routeShare = share?.type === "route" ? share : null;
  const directions = useDirections({
    waypoints: routeShare ? routeShare.route.waypoints.map((w) => [w.lng, w.lat] as LngLat) : [],
    mode: routeShare?.route.mode,
    avoidHighways: routeShare?.route.avoidHighways ?? false,
    avoidTolls: routeShare?.route.avoidTolls ?? false,
    avoidFerries: routeShare?.route.avoidFerries ?? false,
    lang: locale,
  });
  const activeRoute = directions.data?.routes[directions.data.activeRouteIndex ?? 0] ?? null;

  // The root <body> is h-dvh overflow-hidden; this page owns its own scroll.
  return (
    <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <Box
        component="header"
        sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}
      >
        <Typography
          component="a"
          href="/"
          variant="h6"
          sx={{ fontWeight: 700, color: "inherit", textDecoration: "none" }}
        >
          OpenMapX
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }} noWrap>
          {share ? (share.type === "list" ? t("sharedList") : t("sharedRoute")) : ""}
        </Typography>
        <Button variant="contained" size="small" href="/" sx={{ textTransform: "none" }}>
          {t("openInApp")}
        </Button>
      </Box>
      <Divider />
      {share === null ? (
        <Box sx={{ p: 4, textAlign: "center" }}>
          <Typography>{t("unavailable")}</Typography>
        </Box>
      ) : (
        <>
          <Box sx={{ height: "45dvh", flexShrink: 0 }}>
            <SharedMapView
              points={
                share.type === "list"
                  ? share.places.map((p) => ({ lat: p.lat, lng: p.lng }))
                  : share.route.waypoints.map((w) => ({ lat: w.lat, lng: w.lng }))
              }
              routeGeometry={routeShare ? (activeRoute?.geometry ?? null) : null}
            />
          </Box>
          <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1.5 }}>
            {share.type === "list" ? (
              <>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {resolveListIcon(share.icon, 24)}
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    {share.name.startsWith("$") ? tSaved(share.name.slice(1)) : share.name}
                  </Typography>
                </Box>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {t("places", { count: share.places.length })}
                  {" · "}
                  {t("viewerNotice")}
                </Typography>
                {share.places.map((place) => (
                  <Box
                    key={`${place.lat},${place.lng},${place.name}`}
                    sx={{ display: "flex", gap: 1.5, py: 1.25, alignItems: "flex-start" }}
                  >
                    <PlaceIcon sx={{ color: "text.secondary", mt: 0.25 }} fontSize="small" />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 500 }}>{place.name}</Typography>
                      {place.address && (
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {place.address}
                        </Typography>
                      )}
                      {place.note && (
                        <Typography variant="body2" sx={{ fontStyle: "italic" }}>
                          {place.note}
                        </Typography>
                      )}
                    </Box>
                    <Button size="small" href={placeAppUrl(place)} sx={{ textTransform: "none" }}>
                      {t("openPlace")}
                    </Button>
                  </Box>
                ))}
              </>
            ) : (
              routeShare && (
                <SharedRouteContent
                  share={routeShare}
                  activeRoute={activeRoute}
                  provider={directions.data?.provider}
                  isError={directions.isError}
                />
              )
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

function SharedRouteContent({
  share,
  activeRoute,
  provider,
  isError,
}: {
  share: Extract<PublicShare, { type: "route" }>;
  activeRoute: Route | null;
  provider: string | undefined;
  isError: boolean;
}) {
  const t = useTranslations("share");
  const registry = useIntegrationRegistry();
  const routingAttributions = useMemo(
    () => (provider ? attributionsForProviders(registry, [provider]) : []),
    [registry, provider],
  );
  const openUrl = toRelative(
    buildDirectionsDeepLinkUrl("http://share.invalid/", {
      waypoints: share.route.waypoints.map((w) => ({
        coords: [w.lng, w.lat] as LngLat,
        label: w.label,
      })),
      mode: share.route.mode,
      avoidHighways: share.route.avoidHighways,
      avoidTolls: share.route.avoidTolls,
      avoidFerries: share.route.avoidFerries,
    }),
  );
  return (
    <Box>
      {share.route.waypoints.map((waypoint) => (
        <Typography
          key={`${waypoint.lat},${waypoint.lng},${waypoint.label ?? ""}`}
          sx={{ py: 0.5 }}
        >
          {waypoint.label?.trim() || `${waypoint.lat.toFixed(4)}, ${waypoint.lng.toFixed(4)}`}
        </Typography>
      ))}
      {activeRoute && (
        <Typography variant="body2" sx={{ color: "text.secondary", py: 0.5 }}>
          {formatDistance(activeRoute.distance)} · {formatDuration(activeRoute.duration)}
        </Typography>
      )}
      {isError && (
        <Typography variant="body2" sx={{ color: "text.secondary", py: 0.5 }}>
          {t("routeUnavailable")}
        </Typography>
      )}
      <Button variant="outlined" size="small" href={openUrl} sx={{ textTransform: "none", mt: 1 }}>
        {t("openRouteInApp")}
      </Button>
      {routingAttributions.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <AttributionStrip attributions={routingAttributions} variant="inline" />
        </Box>
      )}
    </Box>
  );
}
