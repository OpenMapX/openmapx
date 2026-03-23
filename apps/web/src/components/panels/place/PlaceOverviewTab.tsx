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
import type { MergedDeparture, MergedRoute, Place, TransportMode } from "@openmapx/core";
import {
  computePlusCode,
  parseOpeningHours,
  plusCodeUrl,
  shortenPlusCode,
  useDeleteLabel,
  useIsSaved,
  useLabeledPlaces,
  useSavedLists,
  useSession,
  useUpdateLabel,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { resolveListIcon } from "@/lib/listIcon";
import { TEAL } from "@/lib/theme";
import { PlaceTransitSection } from "../transit/PlaceTransitSection";
import { DataSourceSections } from "./DataSourceSections";
import { PlaceActionButtons } from "./PlaceActionButtons";

interface Props {
  place: Place;
  isLoading: boolean;
  onNavigateToInfo: () => void;
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
      <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>{icon}</Box>
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

export function PlaceOverviewTab({
  place,
  isLoading,
  onNavigateToInfo,
  onOpenDepartures,
  onOpenLineDetail,
  onOpenTripDetail,
}: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const tSaved = useTranslations("saved");
  const hours = parseOpeningHours(place.openingHours, {
    lat: place.coordinates[1],
    lon: place.coordinates[0],
    countryCode: place.countryCode,
  });
  const plusCode = computePlusCode(place.coordinates);
  const shortCode = shortenPlusCode(plusCode);
  const city = place.city ?? null;
  const shortCodeDisplay = city ? `${shortCode} ${city}` : null;
  const [hoursExpanded, setHoursExpanded] = useState(false);
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

  return (
    <>
      <Box sx={{ px: 2, pt: 1.5, pb: 2 }}>
        {/* Action buttons */}
        <PlaceActionButtons place={place} />

        {/* Saved-in banner */}
        {savedInLists.length > 0 && (
          <>
            <Divider sx={{ my: 1 }} />
            {savedInLists.length === 1 || savedExpanded ? (
              savedInLists.map((sl) => (
                <Box key={sl.id} sx={{ display: "flex", gap: 1.5, alignItems: "center", py: 1 }}>
                  <Box sx={{ flexShrink: 0, display: "flex" }}>{resolveListIcon(sl.icon)}</Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" color="text.secondary">
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
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
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

        {/* Description — clickable row leading to Info tab */}
        {place.description && <Divider sx={{ my: 1 }} />}
        {place.description && (
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
            <Typography variant="body2" color="text.primary">
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
              <Typography variant="caption" color="text.secondary">
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
            hours && (
              <Box
                onClick={hours.weekSchedule ? () => setHoursExpanded((v) => !v) : undefined}
                sx={{
                  display: "flex",
                  gap: 2,
                  alignItems: "flex-start",
                  py: 1.25,
                  ...(hours.weekSchedule
                    ? { cursor: "pointer", mx: -2, px: 2, "&:hover": { bgcolor: "action.hover" } }
                    : {}),
                }}
              >
                <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: "2px" }}>
                  <AccessTimeIcon sx={{ fontSize: 22 }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {/* Status row */}
                  <Box sx={{ display: "flex", alignItems: "center" }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography
                        variant="body2"
                        component="span"
                        fontWeight={500}
                        color={hours.isOpen ? "success.main" : "error.main"}
                      >
                        {hours.isOpen ? tc("open") : tc("closed")}
                      </Typography>
                      {hours.detail && (
                        <Typography variant="body2" component="span" color="text.secondary">
                          {" · "}
                          {hours.detail}
                        </Typography>
                      )}
                    </Box>
                    {hours.weekSchedule &&
                      (hoursExpanded ? (
                        <ExpandLessIcon
                          sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0, ml: 0.5 }}
                        />
                      ) : (
                        <ExpandMoreIcon
                          sx={{ fontSize: 18, color: "text.secondary", flexShrink: 0, ml: 0.5 }}
                        />
                      ))}
                  </Box>

                  {/* Expanded weekly schedule */}
                  {hoursExpanded && hours.weekSchedule && (
                    <Box sx={{ mt: 1, mb: 0.5 }}>
                      {hours.weekSchedule.map(({ day, hours: h, isToday }) => (
                        <Box key={day} sx={{ display: "flex", gap: 2, py: 0.4 }}>
                          <Typography
                            variant="body2"
                            fontWeight={isToday ? 600 : 400}
                            color={isToday ? "text.primary" : "text.secondary"}
                            sx={{ width: 96, flexShrink: 0 }}
                          >
                            {day}
                          </Typography>
                          <Typography
                            variant="body2"
                            fontWeight={isToday ? 600 : 400}
                            color={isToday ? "text.primary" : "text.secondary"}
                          >
                            {h}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              </Box>
            )
          )}

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
                  href={place.website}
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
                href={place.wikipediaUrl}
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
            <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>
              <FlagOutlinedIcon sx={{ fontSize: 22 }} />
            </Box>
            {existingLabel ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <Typography variant="body2" color="text.primary">
                  {tSaved("label")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {existingLabel.label.charAt(0).toUpperCase() + existingLabel.label.slice(1)}
                </Typography>
              </Box>
            ) : (
              <Typography variant="body2" color="text.primary">
                {tSaved("addLabel")}
              </Typography>
            )}
          </Box>
        </Box>
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
                  ? { bgcolor: TEAL, color: "#fff", "& .MuiChip-icon": { color: "#fff" } }
                  : { borderColor: TEAL, color: TEAL, "& .MuiChip-icon": { color: TEAL } }
              }
            />
            <Chip
              icon={<WorkIcon sx={{ fontSize: 18 }} />}
              label={tSaved("work")}
              variant={existingLabel?.label === "work" ? "filled" : "outlined"}
              onClick={() => toggleLabel("work")}
              sx={
                existingLabel?.label === "work"
                  ? { bgcolor: TEAL, color: "#fff", "& .MuiChip-icon": { color: "#fff" } }
                  : { borderColor: TEAL, color: TEAL, "& .MuiChip-icon": { color: TEAL } }
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
            sx={{ color: TEAL }}
          >
            {tc("done")}
          </Button>
        </DialogActions>
      </Dialog>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
      {/* Transit section — self-hides if no linked stops */}
      <PlaceTransitSection
        place={place}
        onOpenDepartures={onOpenDepartures}
        onOpenLineDetail={onOpenLineDetail}
        onOpenTripDetail={onOpenTripDetail}
      />
      {/* Data source detail sections (e.g. EV charging connectors) */}
      {place.dataSourceDetail && <DataSourceSections detail={place.dataSourceDetail} />}
    </>
  );
}
