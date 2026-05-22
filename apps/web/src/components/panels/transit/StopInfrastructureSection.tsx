"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ScheduleIcon from "@mui/icons-material/Schedule";
import TrainIcon from "@mui/icons-material/Train";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  PANEL,
  usePlaceStopInfrastructure,
  usePlaceStore,
  useSidebarStore,
  withId,
} from "@openmapx/core";
import type {
  TransitFareZoneSummary,
  TransitInterchangeComplexity,
  TransitPlatformDetail,
  TransitStopAreaSummary,
  TransitStopInfrastructure,
  TransitStopParking,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";
import { type StructuredSection, StructuredSections } from "../shared/StructuredSections";

interface StopInfrastructureSectionProps {
  place: Place;
  onOpenStopBoard: (stopId: string, title: string) => void;
}

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
};

function formatEnum(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function platformTitle(platform: TransitPlatformDetail, parentName?: string): string {
  if (platform.publicCode)
    return `${parentName ?? platform.name} · Platform ${platform.publicCode}`;
  if (platform.privateCode) return `${parentName ?? platform.name} · ${platform.privateCode}`;
  return parentName ?? platform.name;
}

function parkingKindLabel(
  t: ReturnType<typeof useTranslations>,
  parking: TransitStopParking,
): string {
  switch (parking.kind) {
    case "bike_parking":
      return t("parkingTypeBike");
    case "park_and_ride":
      return t("parkingTypeParkRide");
    case "parking":
      return t("parkingTypeCar");
    default:
      return t("parkingTypeOther");
  }
}

function stationComplexityLabel(
  t: ReturnType<typeof useTranslations>,
  complexity: TransitInterchangeComplexity,
  modeCount: number,
): string {
  const isMultimodal = modeCount > 1;
  switch (complexity) {
    case "major_interchange":
      return isMultimodal
        ? t("complexityMajorMultimodalInterchange")
        : t("complexityMajorInterchange");
    case "regional_hub":
      return isMultimodal ? t("complexityRegionalMultimodalHub") : t("complexityRegionalHub");
    case "interchange":
      return isMultimodal ? t("complexityMultimodalInterchange") : t("complexityInterchange");
    default:
      return t("complexitySimpleStop");
  }
}

function fareZoneDisplayName(zone: TransitFareZoneSummary): string {
  return zone.privateCode?.trim() ? zone.privateCode : zone.name;
}

function fareZoneSummaryBits(zone: TransitFareZoneSummary): string | undefined {
  const bits = [zone.authorityName, zone.privateCode].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : undefined;
}

function buildFareZoneExplanation(
  t: ReturnType<typeof useTranslations>,
  zones: TransitFareZoneSummary[],
): { summary: string; note: string } | null {
  if (zones.length === 0) return null;

  const authorities = Array.from(
    new Set(
      zones.map((zone) => zone.authorityName).filter((value): value is string => Boolean(value)),
    ),
  );
  if (zones.length === 1) {
    const zone = zones[0];
    const zoneName = fareZoneDisplayName(zone);
    return {
      summary: zone.authorityName
        ? t("fareZoneSingleAuthoritySummary", { authority: zone.authorityName, zone: zoneName })
        : t("fareZoneSingleSummary", { zone: zoneName }),
      note: t("fareZoneGeneralNote"),
    };
  }

  if (authorities.length === 1) {
    return {
      summary: t("fareZoneMultipleAuthoritySummary", {
        count: zones.length,
        authority: authorities[0],
      }),
      note: t("fareZoneBoundaryNote"),
    };
  }

  return {
    summary: t("fareZoneMultipleNetworkSummary", {
      zoneCount: zones.length,
      authorityCount: authorities.length,
    }),
    note: t("fareZoneBoundaryNote"),
  };
}

function buildStationSummary(
  t: ReturnType<typeof useTranslations>,
  infrastructure: TransitStopInfrastructure,
): string | null {
  const intelligence = infrastructure.stationIntelligence;
  if (!intelligence) return null;

  const bits: string[] = [
    stationComplexityLabel(t, intelligence.complexity, intelligence.modeCount),
  ];
  if (infrastructure.childStops.length > 0) {
    bits.push(t("stationSummaryChildStops", { count: infrastructure.childStops.length }));
  } else if (infrastructure.siblingStops.length > 0) {
    bits.push(t("stationSummaryConnectedStops", { count: infrastructure.siblingStops.length + 1 }));
  }
  if (infrastructure.platforms.length > 0) {
    bits.push(t("stationSummaryPlatforms", { count: infrastructure.platforms.length }));
  }
  if (intelligence.hasRealtimeParking) {
    bits.push(t("stationSummaryLiveParking"));
  } else if (intelligence.hasParking) {
    bits.push(t("stationSummaryAttachedParking"));
  }
  return bits.join(" · ");
}

function parkingFacts(
  t: ReturnType<typeof useTranslations>,
  parking: TransitStopParking,
  stationName: string,
): Place["facts"] {
  const facts = [
    { label: t("parkingType"), value: parkingKindLabel(t, parking) },
    { label: t("parentStation"), value: stationName },
  ];
  if (parking.capacity !== undefined) {
    facts.push({ label: t("parkingCapacityLabel"), value: String(parking.capacity) });
  }
  if (parking.freeSpaces !== undefined) {
    facts.push({ label: t("parkingFreeSpacesLabel"), value: String(parking.freeSpaces) });
  }
  if (parking.hasRealtimeData && parking.freeSpaces !== undefined) {
    facts.push({
      label: t("parkingRealtimeLabel"),
      value: t("yes"),
    });
  }
  return facts;
}

function InfrastructureBlock({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Box sx={{ px: 2, py: 1.25 }}>
      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
        <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: 0.25 }}>{icon}</Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.75 }}>
            {title}
          </Typography>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

function StopAreaRow({
  stop,
  onOpenBoard,
  modeLabel,
  boardLabel,
  secondaryLabel,
}: {
  stop: TransitStopAreaSummary;
  onOpenBoard: (stopId: string, title: string) => void;
  modeLabel: (mode: TransportMode) => string;
  boardLabel: string;
  secondaryLabel?: string;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 1,
        "&:not(:last-child)": { borderBottom: "1px solid", borderColor: "divider" },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500} noWrap>
          {stop.name}
        </Typography>
        {secondaryLabel && (
          <Typography variant="caption" color="text.secondary" display="block">
            {secondaryLabel}
          </Typography>
        )}
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
          {stop.modes.map((mode) => (
            <Chip
              key={`${stop.id}-${mode}`}
              size="small"
              label={modeLabel(mode)}
              variant="outlined"
            />
          ))}
        </Box>
      </Box>
      <Button
        size="small"
        startIcon={<ScheduleIcon />}
        onClick={() => onOpenBoard(stop.id, stop.name)}
        sx={{ textTransform: "none", color: TEAL, flexShrink: 0 }}
      >
        {boardLabel}
      </Button>
    </Box>
  );
}

function buildStructuredSections(
  t: ReturnType<typeof useTranslations>,
  infrastructure: TransitStopInfrastructure,
): StructuredSection[] {
  const areaRows: (string | number)[][] = [];
  if (infrastructure.canonicalStop.stopType) {
    areaRows.push([t("stopType"), formatEnum(infrastructure.canonicalStop.stopType) as string]);
  }
  if (infrastructure.canonicalStop.weighting) {
    areaRows.push([t("weighting"), formatEnum(infrastructure.canonicalStop.weighting) as string]);
  }
  if (infrastructure.parentStop) {
    areaRows.push([t("parentStation"), infrastructure.parentStop.name]);
  }
  if (infrastructure.topographicPlace) {
    const placeType = formatEnum(infrastructure.topographicPlace.placeType);
    areaRows.push([
      t("topographicPlace"),
      placeType
        ? `${infrastructure.topographicPlace.name} · ${placeType}`
        : infrastructure.topographicPlace.name,
    ]);
  }

  const sections: StructuredSection[] = [];
  if (areaRows.length > 0) {
    sections.push({
      id: "area",
      title: t("area"),
      type: "table",
      rows: areaRows,
      sectionIcon: <AccountTreeIcon />,
    });
  }
  if (infrastructure.accessibility.length > 0) {
    sections.push({
      id: "accessibility",
      title: t("accessibility"),
      type: "table",
      rows: infrastructure.accessibility.map((item) => [
        item.label,
        item.available ? t("yes") : t("no"),
      ]),
      sectionIcon: <AccessibleIcon />,
    });
  }
  if (infrastructure.amenities.length > 0) {
    sections.push({
      id: "amenities",
      title: t("amenities"),
      type: "table",
      rows: infrastructure.amenities.map((item) => [
        item.label,
        item.count !== undefined ? String(item.count) : t("available"),
      ]),
      sectionIcon: <DirectionsTransitIcon />,
    });
  }
  if (infrastructure.facts.length > 0) {
    sections.push({
      id: "facts",
      title: t("stationFacts"),
      type: "table",
      rows: infrastructure.facts.map((fact) => [fact.label, fact.value]),
      sectionIcon: <InfoOutlinedIcon />,
      collapsed: infrastructure.facts.length > 4,
    });
  }
  return sections;
}

export function StopInfrastructureSection({
  place,
  onOpenStopBoard,
}: StopInfrastructureSectionProps) {
  const t = useTranslations("transit");
  const { data, isLoading, resolvedStopId } = usePlaceStopInfrastructure(place);
  const transitMapFocus = usePlaceStore((state) => state.transitMapFocus);
  const focusTransitMapFeature = usePlaceStore((state) => state.focusTransitMapFeature);
  const setSelectedPlace = usePlaceStore((state) => state.setSelectedPlace);
  const { flyTo } = useMap();

  if (!resolvedStopId && !isLoading) return null;

  const modeLabel = (mode: TransportMode) =>
    MODE_LABEL_KEYS[mode] ? t(MODE_LABEL_KEYS[mode] as string) : mode;

  if (isLoading) {
    return (
      <Box sx={{ px: 2, py: 1.5 }}>
        <Divider sx={{ mb: 1.5 }} />
        <Skeleton variant="text" width="45%" height={20} sx={{ mb: 1 }} />
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} variant="rounded" height={44} sx={{ mb: 1 }} />
        ))}
      </Box>
    );
  }

  if (!data) return null;

  const areaLookupEntries: Array<readonly [string, TransitStopAreaSummary]> = [
    [data.canonicalStop.id, data.canonicalStop] as const,
    ...data.childStops.map((stop) => [stop.id, stop] as const),
    ...data.siblingStops.map((stop) => [stop.id, stop] as const),
    ...(data.parentStop ? [[data.parentStop.id, data.parentStop] as const] : []),
  ];
  const areaLookup = new Map<string, TransitStopAreaSummary>(areaLookupEntries);
  const groupedPlatforms = data.platforms.reduce<Map<string, TransitPlatformDetail[]>>(
    (groups, platform) => {
      const key = platform.parentStopId;
      const list = groups.get(key) ?? [];
      list.push(platform);
      groups.set(key, list);
      return groups;
    },
    new Map(),
  );
  const structuredSections = buildStructuredSections(t, data);
  const stopAreaGeometry = data.geometry?.stopArea;
  const fareZoneGeometryIds = new Set(
    data.geometry?.fareZones?.map((zone) => zone.fareZoneId) ?? [],
  );
  const stationSummary = buildStationSummary(t, data);
  const fareZoneExplanation = buildFareZoneExplanation(t, data.fareZones);
  const stationName = data.parentStop?.name ?? data.canonicalStop.name;
  const relatedStops =
    data.childStops.length > 0
      ? data.childStops
      : data.siblingStops.length > 0
        ? [data.canonicalStop, ...data.siblingStops]
        : [];

  const openParkingDetail = (parking: TransitStopParking) => {
    flyTo([parking.lng, parking.lat], 17);
    setSelectedPlace(
      withId<Place>({
        primaryScheme: "entur",
        ids: { entur: parking.id },
        name: parking.name,
        address: stationName,
        coordinates: [parking.lng, parking.lat],
        category: parkingKindLabel(t, parking),
        rawCategory: "parking",
        facts: parkingFacts(t, parking, stationName),
      }),
    );
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  };

  return (
    <Box sx={{ pb: 1 }}>
      <Divider sx={{ mx: 2, my: 1 }} />
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 2,
          pt: 1.5,
          pb: 0.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
          <TrainIcon sx={{ fontSize: 20, color: TEAL }} />
          <Typography variant="subtitle2" fontWeight={600} color="text.primary">
            {t("stationDetails")}
          </Typography>
        </Box>
        {stopAreaGeometry && (
          <Button
            size="small"
            startIcon={<MapOutlinedIcon />}
            onClick={() =>
              focusTransitMapFeature(
                { kind: "stop-area", id: data.canonicalStop.id },
                { reveal: true },
              )
            }
            sx={{ textTransform: "none", color: TEAL, flexShrink: 0 }}
          >
            {t("revealOnMap")}
          </Button>
        )}
      </Box>

      {stationSummary && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Box
            sx={{
              px: 1.5,
              py: 1.25,
              borderRadius: 2,
              bgcolor: "rgba(15, 157, 88, 0.08)",
              border: "1px solid rgba(15, 157, 88, 0.16)",
            }}
          >
            <Typography variant="body2" fontWeight={600}>
              {stationSummary}
            </Typography>
          </Box>
        </Box>
      )}

      {structuredSections.find((section) => section.id === "area") && (
        <StructuredSections
          sections={structuredSections.filter((section) => section.id === "area")}
        />
      )}

      {relatedStops.length > 0 && (
        <InfrastructureBlock
          icon={<AccountTreeIcon />}
          title={data.childStops.length > 0 ? t("childStopAreas") : t("relatedStopAreas")}
        >
          {relatedStops.map((stop) => (
            <StopAreaRow
              key={stop.id}
              stop={stop}
              onOpenBoard={onOpenStopBoard}
              modeLabel={modeLabel}
              boardLabel={t("openBoard")}
              secondaryLabel={
                stop.id === data.canonicalStop.id && data.parentStop ? t("focusedArea") : undefined
              }
            />
          ))}
        </InfrastructureBlock>
      )}

      {data.platforms.length > 0 && (
        <InfrastructureBlock icon={<TrainIcon />} title={t("platforms")}>
          {Array.from(groupedPlatforms.entries()).map(([parentStopId, platforms]) => {
            const parentStop = areaLookup.get(parentStopId);
            return (
              <Box key={parentStopId} sx={{ "&:not(:last-child)": { mb: 1.5 } }}>
                {groupedPlatforms.size > 1 && parentStop && (
                  <Typography variant="caption" color="text.secondary" fontWeight={600}>
                    {parentStop.name}
                  </Typography>
                )}
                {platforms.map((platform) => {
                  const isFocused =
                    (data.requestedStop.level === "platform" &&
                      data.requestedStop.id === platform.id) ||
                    (transitMapFocus?.kind === "platform" && transitMapFocus.id === platform.id);
                  const detailBits = [
                    platform.publicCode ? null : platform.privateCode,
                    platform.boardingPositions?.length
                      ? `${t("boardingPositions")}: ${platform.boardingPositions.join(", ")}`
                      : null,
                  ].filter(Boolean);

                  return (
                    <Box
                      key={platform.id}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        py: 1,
                        mt: 0.5,
                        px: 1,
                        borderRadius: 1.5,
                        bgcolor: isFocused ? "rgba(15, 157, 88, 0.08)" : "transparent",
                        border: "1px solid",
                        borderColor: isFocused ? "rgba(15, 157, 88, 0.25)" : "divider",
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={500} noWrap>
                          {platform.publicCode
                            ? `${t("platform")} ${platform.publicCode}`
                            : (platform.privateCode ?? platform.name)}
                        </Typography>
                        {detailBits.length > 0 && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            {detailBits.join(" · ")}
                          </Typography>
                        )}
                        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                          {platform.accessibilityLabels?.map((label) => (
                            <Chip
                              key={`${platform.id}-${label}`}
                              size="small"
                              label={label}
                              variant="outlined"
                            />
                          ))}
                          {platform.amenityLabels?.map((label) => (
                            <Chip
                              key={`${platform.id}-${label}`}
                              size="small"
                              label={label}
                              variant="outlined"
                            />
                          ))}
                        </Box>
                        <Button
                          size="small"
                          startIcon={<MapOutlinedIcon />}
                          onClick={() =>
                            focusTransitMapFeature(
                              { kind: "platform", id: platform.id },
                              { reveal: true },
                            )
                          }
                          sx={{
                            mt: 0.5,
                            px: 0,
                            minWidth: 0,
                            textTransform: "none",
                            color: TEAL,
                          }}
                        >
                          {t("showOnMap")}
                        </Button>
                      </Box>
                      <Button
                        size="small"
                        startIcon={<ScheduleIcon />}
                        onClick={() =>
                          onOpenStopBoard(platform.id, platformTitle(platform, parentStop?.name))
                        }
                        sx={{ textTransform: "none", color: TEAL, flexShrink: 0 }}
                      >
                        {t("openBoard")}
                      </Button>
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </InfrastructureBlock>
      )}

      {data.parking.length > 0 && (
        <InfrastructureBlock icon={<LocalParkingIcon />} title={t("parking")}>
          {data.parking.map((parking) => {
            const isFocused =
              transitMapFocus?.kind === "parking" && transitMapFocus.id === parking.id;
            const detailBits = [
              parkingKindLabel(t, parking),
              parking.capacity !== undefined
                ? t("parkingCapacity", { count: parking.capacity })
                : null,
              parking.freeSpaces !== undefined
                ? t("parkingFreeSpaces", { count: parking.freeSpaces })
                : null,
            ].filter(Boolean);

            return (
              <Box
                key={parking.id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 1,
                  px: 1,
                  mt: 0.5,
                  borderRadius: 1.5,
                  bgcolor: isFocused ? "rgba(15, 157, 88, 0.08)" : "transparent",
                  border: "1px solid",
                  borderColor: isFocused ? "rgba(15, 157, 88, 0.25)" : "divider",
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={500} noWrap>
                    {parking.name}
                  </Typography>
                  {detailBits.length > 0 && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {detailBits.join(" · ")}
                    </Typography>
                  )}
                  <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                    {parking.hasRealtimeData && parking.freeSpaces !== undefined && (
                      <Chip size="small" label={t("parkingLiveOccupancy")} variant="outlined" />
                    )}
                    {parking.freeSpaces !== undefined && (
                      <Chip
                        size="small"
                        label={t("parkingFreeSpaces", { count: parking.freeSpaces })}
                        variant="outlined"
                      />
                    )}
                  </Box>
                </Box>
                <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, flexShrink: 0 }}>
                  <Button
                    size="small"
                    startIcon={<MapOutlinedIcon />}
                    variant={isFocused ? "contained" : "text"}
                    onClick={() =>
                      focusTransitMapFeature({ kind: "parking", id: parking.id }, { reveal: true })
                    }
                    sx={{
                      textTransform: "none",
                      color: isFocused ? "#FFFFFF" : TEAL,
                      bgcolor: isFocused ? TEAL : undefined,
                      "&:hover": isFocused
                        ? { bgcolor: "var(--omx-teal-hover)" }
                        : { bgcolor: "var(--omx-hover-bg)" },
                    }}
                  >
                    {t("showOnMap")}
                  </Button>
                  <Button
                    size="small"
                    startIcon={<OpenInNewIcon />}
                    onClick={() => openParkingDetail(parking)}
                    sx={{ textTransform: "none", color: TEAL }}
                  >
                    {t("parkingDetails")}
                  </Button>
                </Box>
              </Box>
            );
          })}
        </InfrastructureBlock>
      )}

      {data.fareZones.length > 0 && (
        <InfrastructureBlock icon={<TrainIcon />} title={t("fareZones")}>
          {fareZoneExplanation && (
            <Box
              sx={{
                px: 1,
                py: 0.75,
                mb: 0.5,
                borderRadius: 1.5,
                bgcolor: "rgba(217, 119, 6, 0.08)",
                border: "1px solid rgba(217, 119, 6, 0.16)",
              }}
            >
              <Typography variant="body2" fontWeight={500}>
                {fareZoneExplanation.summary}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                {fareZoneExplanation.note}
              </Typography>
            </Box>
          )}
          {data.fareZones.map((zone) => {
            const isFocused =
              transitMapFocus?.kind === "fare-zone" && transitMapFocus.id === zone.id;
            return (
              <Box
                key={zone.id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 1,
                  "&:not(:last-child)": { borderBottom: "1px solid", borderColor: "divider" },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={500} noWrap>
                    {zone.name}
                  </Typography>
                  {fareZoneSummaryBits(zone) && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {fareZoneSummaryBits(zone)}
                    </Typography>
                  )}
                  {zone.isDeprecatedTariffZone && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {t("deprecatedFareZone")}
                    </Typography>
                  )}
                </Box>
                {fareZoneGeometryIds.has(zone.id) && (
                  <Button
                    size="small"
                    startIcon={<MapOutlinedIcon />}
                    variant={isFocused ? "contained" : "text"}
                    onClick={() =>
                      focusTransitMapFeature({ kind: "fare-zone", id: zone.id }, { reveal: true })
                    }
                    sx={{
                      textTransform: "none",
                      color: isFocused ? "#FFFFFF" : TEAL,
                      bgcolor: isFocused ? TEAL : undefined,
                      flexShrink: 0,
                      "&:hover": isFocused
                        ? { bgcolor: "var(--omx-teal-hover)" }
                        : { bgcolor: "var(--omx-hover-bg)" },
                    }}
                  >
                    {t("showOnMap")}
                  </Button>
                )}
              </Box>
            );
          })}
        </InfrastructureBlock>
      )}

      <StructuredSections
        sections={structuredSections.filter(
          (section) => section.id !== "area" && section.id !== "platforms",
        )}
      />
    </Box>
  );
}
