"use client";

import AccessTimeIcon from "@mui/icons-material/AccessTime";
import AppsIcon from "@mui/icons-material/Apps";
import ArticleIcon from "@mui/icons-material/Article";
import CheckIcon from "@mui/icons-material/Check";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FlagOutlinedIcon from "@mui/icons-material/FlagOutlined";
import HomeIcon from "@mui/icons-material/Home";
import LanguageIcon from "@mui/icons-material/Language";
import PhoneIcon from "@mui/icons-material/Phone";
import PlaceIcon from "@mui/icons-material/Place";
import WavesIcon from "@mui/icons-material/Waves";
import WbSunnyOutlinedIcon from "@mui/icons-material/WbSunnyOutlined";
import WbTwilightIcon from "@mui/icons-material/WbTwilight";
import WorkIcon from "@mui/icons-material/Work";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  computePlusCode,
  isCityOrSmaller,
  plusCodeUrl,
  safeHref,
  shortenPlusCode,
  useDeleteLabel,
  useIsSaved,
  useLabeledPlaces,
  useMarineWeather,
  useSavedLists,
  useSession,
  useTides,
  useUpdateLabel,
} from "@openmapx/core";
import type { MergedDeparture, MergedRoute, TransportMode } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { resolveListIcon } from "@/lib/listIcon";
import { BRAND } from "@/lib/theme";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";
import { useMobileSheet } from "../sheet/sheetState";
import { PlaceTransitSection } from "../transit/PlaceTransitSection";
import { DataSourceSections } from "./DataSourceSections";
import { PlaceActionButtons } from "./PlaceActionButtons";
import { PlaceAirportInfo } from "./PlaceAirportInfo";
import { PlaceCitySections } from "./PlaceCitySections";
import { PlaceFoodActions } from "./PlaceFoodActions";
import { PlaceHarborFacilities } from "./PlaceHarborFacilities";
import { PlaceHotelActions } from "./PlaceHotelActions";
import { PlaceMarineWeatherContent } from "./PlaceMarineWeather";
import { PlaceSunTimes } from "./PlaceSunTimes";
import { PlaceTagDetails } from "./PlaceTagDetails";
import { PlaceTidesContent } from "./PlaceTides";
import { PlaceWeather } from "./PlaceWeather";

interface Props {
  place: Place;
  isLoading: boolean;
  onNavigateToInfo: () => void;
  onOpenPrices?: () => void;
  onOpenDepartures: (mode?: TransportMode) => void;
  onOpenLineDetail: (route: MergedRoute) => void;
  onOpenTripDetail?: (dep: MergedDeparture) => void;
}

function DetailRow({
  icon,
  children,
  copyValue,
  copyLabel,
}: {
  icon: ReactNode;
  children: ReactNode;
  copyValue?: string;
  copyLabel?: string;
}) {
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!copyValue) return;
    navigator.clipboard.writeText(copyValue).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  return (
    <Box
      sx={{
        display: "flex",
        gap: 2,
        alignItems: "center",
        py: 1.25,
        ...(copyValue
          ? {
              mx: -2,
              px: 2,
              "&:hover": { bgcolor: "action.hover" },
              "& .copy-btn": { opacity: 0 },
              "&:hover .copy-btn": { opacity: 1 },
            }
          : {}),
      }}
    >
      <Box sx={{ color: BRAND, flexShrink: 0, display: "flex" }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      {copyValue && (
        <Tooltip title={copied ? tc("copied") : (copyLabel ?? tc("copy"))}>
          <IconButton
            className="copy-btn"
            size="small"
            onClick={handleCopy}
            sx={{ color: "text.secondary", flexShrink: 0, p: 0.5, transition: "opacity 0.15s" }}
          >
            {copied ? (
              <CheckIcon sx={{ fontSize: 18 }} />
            ) : (
              <ContentCopyIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

function ExpandableDetailRow({
  icon,
  label,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      onClick={onToggle}
      sx={{
        py: 1.25,
        cursor: "pointer",
        mx: -2,
        px: 2,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
        <Box sx={{ color: BRAND, flexShrink: 0, display: "flex" }}>{icon}</Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>{label}</Box>
        {expanded ? (
          <ExpandLessIcon sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0 }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0 }} />
        )}
      </Box>
      {expanded && <Box sx={{ pl: "38px" }}>{children}</Box>}
    </Box>
  );
}

export function PlaceOverviewTab({
  place,
  isLoading,
  onNavigateToInfo,
  onOpenPrices,
  onOpenDepartures,
  onOpenLineDetail,
  onOpenTripDetail,
}: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const tSaved = useTranslations("saved");
  const tWeather = useTranslations("weather");
  const tSun = useTranslations("sunTimes");
  const tTides = useTranslations("tides");
  const tMarine = useTranslations("marineWeather");
  const { inSheet } = useMobileSheet();
  const ohText = useOpeningHoursText();
  const isCity = isCityOrSmaller(place);
  const hours = place.openingHoursInfo?.status ?? null;
  const plusCode = computePlusCode(place.coordinates);
  const shortCode = shortenPlusCode(plusCode);
  const city = place.city ?? null;
  const shortCodeDisplay = city ? `${shortCode} ${city}` : null;
  const [hoursExpanded, setHoursExpanded] = useState(false);
  const [weatherExpanded, setWeatherExpanded] = useState(false);
  const [sunTimesExpanded, setSunTimesExpanded] = useState(false);
  const [tidesExpanded, setTidesExpanded] = useState(false);
  const [marineExpanded, setMarineExpanded] = useState(false);
  // Fetch unconditionally — the route 204s for inland users (most users),
  // which is cheap, and lets us hide the row entirely instead of rendering
  // a "Tides" row that expands to nothing.
  const { data: tidesData } = useTides(place.coordinates[1], place.coordinates[0]);
  // Same shape — Open-Meteo Marine returns 204 for inland points so the row
  // self-hides for everyone except coastal/at-sea places.
  const { data: marineData } = useMarineWeather(place.coordinates[1], place.coordinates[0]);
  const [savedExpanded, setSavedExpanded] = useState(false);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelName, setLabelName] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const { data: session } = useSession();
  const updateLabelMutation = useUpdateLabel();
  const deleteLabelMutation = useDeleteLabel();
  const isAuthenticated = Boolean(session?.user);
  const { data: savedInListIds } = useIsSaved(isAuthenticated ? place.id : null);
  const { data: allLists } = useSavedLists();
  const { data: labeledPlaces } = useLabeledPlaces();

  const savedInLists = allLists?.filter((l) => savedInListIds?.includes(l.id)) ?? [];
  const existingLabel = labeledPlaces?.find((lp) => lp.placeId === place.id);

  const resolveListName = (name: string) => (name.startsWith("$") ? tSaved(name.slice(1)) : name);

  const handleAddLabel = () => {
    if (!session?.user) {
      setAuthOpen(true);
      return;
    }
    const current = existingLabel?.label ?? "";
    const isSpecial = current === "home" || current === "work";
    setLabelName(isSpecial ? "" : current);
    setLabelDialogOpen(true);
  };

  const toggleLabel = (label: string) => {
    if (existingLabel?.label === label) {
      deleteLabelMutation.mutate(label);
    } else {
      if (existingLabel) {
        deleteLabelMutation.mutate(existingLabel.label);
      }
      updateLabelMutation.mutate({
        label,
        name: place.name,
        address: place.address ?? undefined,
        lat: place.coordinates[1],
        lng: place.coordinates[0],
        placeId: place.id,
      });
    }
    setLabelDialogOpen(false);
  };

  const isEditingLabel =
    existingLabel !== undefined && existingLabel.label !== "home" && existingLabel.label !== "work";

  const handleLabelSubmit = () => {
    const trimmed = labelName.trim();
    if (!trimmed && existingLabel) {
      deleteLabelMutation.mutate(existingLabel.label);
      setLabelDialogOpen(false);
      return;
    }
    if (!trimmed) return;
    toggleLabel(trimmed);
  };

  // Clickable row leading to the Info tab. Suppressed for cities, where the
  // Quick facts section already surfaces the same text.
  const descriptionRow =
    place.description && !isCity ? (
      <Box
        role="button"
        tabIndex={0}
        onClick={onNavigateToInfo}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onNavigateToInfo();
          }
        }}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          py: 1.5,
          mx: -2,
          px: 2,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography variant="body2" sx={{ flex: 1, color: "text.primary" }}>
          {place.description}
        </Typography>
        <ChevronRightIcon sx={{ fontSize: 20, color: "text.disabled", flexShrink: 0 }} />
      </Box>
    ) : null;

  return (
    <>
      {/* No bottom padding when the description trails the detail rows: it is
          the last child there, so the padding would land between it and the
          next section's divider and read as a wider gap than the one above it. */}
      <Box sx={{ px: 2, pt: 1, pb: descriptionRow && inSheet ? 0 : 1 }}>
        {/* Outside a sheet the actions stay here, at the top of the tab. In a
            sheet they render once above the tabs instead, where they can form
            the collapsed peek layout. */}
        {!inSheet && <PlaceActionButtons place={place} />}

        {/* City-only sections: Quick facts, Hotels, Neighborhoods */}
        {isCity && <PlaceCitySections place={place} onNavigateToInfo={onNavigateToInfo} />}

        {/* Saved-in banner */}
        {savedInLists.length > 0 && (
          <>
            <Divider sx={{ my: 1 }} />
            {savedInLists.length === 1 || savedExpanded ? (
              savedInLists.map((sl) => (
                <Box key={sl.id} sx={{ display: "flex", gap: 1.5, alignItems: "center", py: 1 }}>
                  <Box sx={{ flexShrink: 0, display: "flex" }}>{resolveListIcon(sl.icon)}</Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {tSaved("savedIn", { list: resolveListName(sl.name) })}
                    </Typography>
                  </Box>
                  {savedInLists.length > 1 && sl.id === savedInLists[0].id && (
                    <IconButton
                      size="small"
                      onClick={() => setSavedExpanded(false)}
                      sx={{ flexShrink: 0 }}
                    >
                      <ExpandLessIcon sx={{ fontSize: 20, color: "text.secondary" }} />
                    </IconButton>
                  )}
                </Box>
              ))
            ) : (
              <Box
                onClick={() => setSavedExpanded(true)}
                sx={{ display: "flex", gap: 1.5, alignItems: "center", py: 1, cursor: "pointer" }}
              >
                <Box sx={{ flexShrink: 0, display: "flex" }}>{resolveListIcon("bookmark")}</Box>
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    flex: 1,
                  }}
                >
                  {savedInLists.length === 2
                    ? tSaved("savedInTwo", {
                        list1: resolveListName(savedInLists[0].name),
                        list2: resolveListName(savedInLists[1].name),
                      })
                    : tSaved("savedInMany", {
                        list: resolveListName(savedInLists[0].name),
                        count: savedInLists.length - 1,
                      })}
                </Typography>
                <ExpandMoreIcon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
              </Box>
            )}
          </>
        )}

        {/* Description sits above the detail rows here. In a sheet it moves
            below them instead — with the actions above the tabs, leading with
            a paragraph pushes the address and phone too far down. Rendered in
            exactly one of the two places, so the dividers stay paired with
            whichever block actually follows. */}
        {descriptionRow && !inSheet && (
          <>
            <Divider sx={{ my: 1 }} />
            {descriptionRow}
          </>
        )}

        <Divider sx={{ my: 1 }} />

        {/* Detail rows */}
        <Box sx={{ px: 0 }}>
          {/* Address */}
          <DetailRow
            icon={<PlaceIcon sx={{ fontSize: 22 }} />}
            copyValue={place.address}
            copyLabel={t("copyAddress")}
          >
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {place.address}
            </Typography>
          </DetailRow>

          {/* Plus Code */}
          <DetailRow
            icon={<AppsIcon sx={{ fontSize: 22 }} />}
            copyValue={shortCodeDisplay ?? plusCode}
            copyLabel={t("copyPlusCode")}
          >
            <Link
              href={plusCodeUrl(plusCode)}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              sx={{ display: "block", color: "text.primary", typography: "body2" }}
            >
              {shortCodeDisplay ?? plusCode}
            </Link>
            {shortCodeDisplay && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {plusCode}
              </Typography>
            )}
          </DetailRow>

          {/* Opening hours */}
          {isLoading && !place.openingHours ? (
            <DetailRow icon={<AccessTimeIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="60%" />
            </DetailRow>
          ) : (
            hours &&
            (hours.weekSchedule ? (
              <ExpandableDetailRow
                icon={<AccessTimeIcon sx={{ fontSize: 22 }} />}
                expanded={hoursExpanded}
                onToggle={() => setHoursExpanded((v) => !v)}
                label={
                  <>
                    <Typography
                      variant="body2"
                      component="span"
                      color={hours.isOpen ? "success.main" : "error.main"}
                      sx={{
                        fontWeight: 500,
                      }}
                    >
                      {ohText.state(hours)}
                    </Typography>
                    {ohText.detail(hours) && (
                      <Typography
                        variant="body2"
                        component="span"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {" · "}
                        {ohText.detail(hours)}
                      </Typography>
                    )}
                  </>
                }
              >
                <Box sx={{ mt: 1, mb: 0.5 }}>
                  {hours.weekSchedule.map((entry) => (
                    <Box key={entry.weekday} sx={{ display: "flex", gap: 2, py: 0.4 }}>
                      <Typography
                        variant="body2"
                        color={entry.isToday ? "text.primary" : "text.secondary"}
                        sx={{
                          fontWeight: entry.isToday ? 600 : 400,
                          width: 96,
                          flexShrink: 0,
                        }}
                      >
                        {ohText.weekday(entry.weekday)}
                      </Typography>
                      <Typography
                        variant="body2"
                        color={entry.isToday ? "text.primary" : "text.secondary"}
                        sx={{
                          fontWeight: entry.isToday ? 600 : 400,
                        }}
                      >
                        {ohText.dayHours(entry)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </ExpandableDetailRow>
            ) : (
              <DetailRow icon={<AccessTimeIcon sx={{ fontSize: 22 }} />}>
                {hours.isUnknown ? (
                  <Typography
                    variant="body2"
                    component="span"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {hours.text}
                  </Typography>
                ) : (
                  <>
                    <Typography
                      variant="body2"
                      component="span"
                      color={hours.isOpen ? "success.main" : "error.main"}
                      sx={{
                        fontWeight: 500,
                      }}
                    >
                      {ohText.state(hours)}
                    </Typography>
                    {ohText.detail(hours) && (
                      <Typography
                        variant="body2"
                        component="span"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {" · "}
                        {ohText.detail(hours)}
                      </Typography>
                    )}
                  </>
                )}
              </DetailRow>
            ))
          )}

          {/* Restaurant menu + delivery hand-off (self-hides for non-food places) */}
          <PlaceFoodActions place={place} />
          {/* Hotel prices + booking hand-off (self-hides for non-lodging places) */}
          <PlaceHotelActions place={place} onOpenPrices={onOpenPrices} />

          {/* Phone */}
          {isLoading && !place.phone ? (
            <DetailRow icon={<PhoneIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="45%" />
            </DetailRow>
          ) : (
            place.phone && (
              <DetailRow
                icon={<PhoneIcon sx={{ fontSize: 22 }} />}
                copyValue={place.phone}
                copyLabel={t("copyPhone")}
              >
                <Link
                  href={`tel:${place.phone}`}
                  variant="body2"
                  underline="hover"
                  sx={{ color: "text.primary" }}
                >
                  {place.phone}
                </Link>
              </DetailRow>
            )
          )}

          {/* Website */}
          {isLoading && !place.website ? (
            <DetailRow icon={<LanguageIcon sx={{ fontSize: 22 }} />}>
              <Skeleton variant="text" width="55%" />
            </DetailRow>
          ) : (
            place.website && (
              <DetailRow
                icon={<LanguageIcon sx={{ fontSize: 22 }} />}
                copyValue={place.website}
                copyLabel={t("copyWebsite")}
              >
                <Link
                  href={safeHref(place.website)}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  underline="hover"
                  sx={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "text.primary",
                  }}
                >
                  {place.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </Link>
              </DetailRow>
            )
          )}

          {/* Wikipedia */}
          {place.wikipediaUrl && (
            <DetailRow icon={<ArticleIcon sx={{ fontSize: 22 }} />}>
              <Link
                href={safeHref(place.wikipediaUrl)}
                target="_blank"
                rel="noopener noreferrer"
                variant="body2"
                underline="hover"
                sx={{ color: "text.primary" }}
              >
                {t("wikipedia")}
              </Link>
            </DetailRow>
          )}

          {/* Label row */}
          <Box
            role="button"
            tabIndex={0}
            onClick={handleAddLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleAddLabel();
              }
            }}
            sx={{
              display: "flex",
              gap: 2,
              alignItems: "center",
              py: 1.25,
              cursor: "pointer",
              mx: -2,
              px: 2,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box sx={{ color: BRAND, flexShrink: 0, display: "flex" }}>
              <FlagOutlinedIcon sx={{ fontSize: 22 }} />
            </Box>
            {existingLabel ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.primary",
                  }}
                >
                  {tSaved("label")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {existingLabel.label.charAt(0).toUpperCase() + existingLabel.label.slice(1)}
                </Typography>
              </Box>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  color: "text.primary",
                }}
              >
                {tSaved("addLabel")}
              </Typography>
            )}
          </Box>

          {/* Weather (expandable) */}
          <ExpandableDetailRow
            icon={<WbSunnyOutlinedIcon sx={{ fontSize: 22 }} />}
            expanded={weatherExpanded}
            onToggle={() => setWeatherExpanded((v) => !v)}
            label={
              <Typography
                variant="body2"
                sx={{
                  color: "text.primary",
                }}
              >
                {tWeather("currentWeather")}
              </Typography>
            }
          >
            <PlaceWeather
              lat={place.coordinates[1]}
              lng={place.coordinates[0]}
              enabled={weatherExpanded}
            />
          </ExpandableDetailRow>

          {/* Sunrise & sunset (expandable) */}
          <ExpandableDetailRow
            icon={<WbTwilightIcon sx={{ fontSize: 22 }} />}
            expanded={sunTimesExpanded}
            onToggle={() => setSunTimesExpanded((v) => !v)}
            label={
              <Typography
                variant="body2"
                sx={{
                  color: "text.primary",
                }}
              >
                {tSun("sunriseSunset")}
              </Typography>
            }
          >
            <PlaceSunTimes
              lat={place.coordinates[1]}
              lng={place.coordinates[0]}
              enabled={sunTimesExpanded}
            />
          </ExpandableDetailRow>

          {/* Tides (expandable) — hidden when no NOAA tide station is within range. */}
          {tidesData && (
            <ExpandableDetailRow
              icon={<WavesIcon sx={{ fontSize: 22 }} />}
              expanded={tidesExpanded}
              onToggle={() => setTidesExpanded((v) => !v)}
              label={
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.primary",
                  }}
                >
                  {tTides("section")}
                </Typography>
              }
            >
              <PlaceTidesContent data={tidesData} />
            </ExpandableDetailRow>
          )}

          {/* Marine weather (expandable) — hidden for inland points (204). */}
          {marineData && (
            <ExpandableDetailRow
              icon={<WavesIcon sx={{ fontSize: 22 }} />}
              expanded={marineExpanded}
              onToggle={() => setMarineExpanded((v) => !v)}
              label={
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.primary",
                  }}
                >
                  {tMarine("section")}
                </Typography>
              }
            >
              <PlaceMarineWeatherContent data={marineData} />
            </ExpandableDetailRow>
          )}
        </Box>

        {descriptionRow && inSheet && (
          <>
            <Divider sx={{ my: 1 }} />
            {descriptionRow}
          </>
        )}
      </Box>
      {/* Add label dialog */}
      <Dialog
        open={labelDialogOpen}
        onClose={() => setLabelDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{tSaved(isEditingLabel ? "editLabel" : "addLabel")}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: "flex", gap: 1, mb: 2, mt: 0.5 }}>
            <Chip
              icon={<HomeIcon sx={{ fontSize: 18 }} />}
              label={tSaved("home")}
              variant={existingLabel?.label === "home" ? "filled" : "outlined"}
              onClick={() => toggleLabel("home")}
              sx={
                existingLabel?.label === "home"
                  ? { bgcolor: BRAND, color: "#fff", "& .MuiChip-icon": { color: "#fff" } }
                  : { borderColor: BRAND, color: BRAND, "& .MuiChip-icon": { color: BRAND } }
              }
            />
            <Chip
              icon={<WorkIcon sx={{ fontSize: 18 }} />}
              label={tSaved("work")}
              variant={existingLabel?.label === "work" ? "filled" : "outlined"}
              onClick={() => toggleLabel("work")}
              sx={
                existingLabel?.label === "work"
                  ? { bgcolor: BRAND, color: "#fff", "& .MuiChip-icon": { color: "#fff" } }
                  : { borderColor: BRAND, color: BRAND, "& .MuiChip-icon": { color: BRAND } }
              }
            />
          </Box>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={tSaved("enterLabelName")}
            value={labelName}
            onChange={(e) => setLabelName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleLabelSubmit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLabelDialogOpen(false)}>{tc("cancel")}</Button>
          <Button
            onClick={handleLabelSubmit}
            disabled={!labelName.trim() && !isEditingLabel}
            sx={{ color: BRAND }}
          >
            {tc("done")}
          </Button>
        </DialogActions>
      </Dialog>
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
      {/* Structured OSM tag details (access, indoor, multilingual descriptions, etc.) */}
      {place.osmTags && Object.keys(place.osmTags).length > 0 && (
        <PlaceTagDetails osmTags={place.osmTags} />
      )}
      {/* Transit section — self-hides if no linked stops */}
      <PlaceTransitSection
        place={place}
        onOpenDepartures={onOpenDepartures}
        onOpenLineDetail={onOpenLineDetail}
        onOpenTripDetail={onOpenTripDetail}
      />
      {/* Data source detail sections (e.g. EV charging connectors) */}
      {place.dataSourceDetail && (
        <DataSourceSections detail={place.dataSourceDetail} domain={place.primaryScheme} />
      )}
      {/* Airport detail (runways, frequencies, navaids) — only present on aerodrome/heliport */}
      {place.airport && <PlaceAirportInfo airport={place.airport} />}
      {/* Harbor detail — facilities, OSM link. Surfaces for OpenSeaMap harbour click-throughs. */}
      {place.primaryScheme === "openseamap-harbour" && (
        <PlaceHarborFacilities
          harbourId={place.ids["openseamap-harbour"] ?? ""}
          lat={place.coordinates[1]}
          lng={place.coordinates[0]}
          name={place.name}
        />
      )}
    </>
  );
}
