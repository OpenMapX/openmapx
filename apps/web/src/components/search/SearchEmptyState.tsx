"use client";

import FlagIcon from "@mui/icons-material/Flag";
import HistoryIcon from "@mui/icons-material/History";
import HomeIcon from "@mui/icons-material/Home";
import WorkIcon from "@mui/icons-material/Work";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ListItemButton from "@mui/material/ListItemButton";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { type LabeledPlace, useLabeledPlaces, useSession, useSettingsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { BRAND } from "@/integration-api/runtime/theme";
import { useRecentSearchStore } from "@/stores/recentSearchStore";

interface Props {
  onSelectPlace: (place: LabeledPlace) => void;
  onSelectRecent: (query: string) => void;
  onClearRecent: () => void;
}

function iconFor(label: string): React.ReactNode {
  const lower = label.trim().toLowerCase();
  if (lower === "home") return <HomeIcon sx={{ color: BRAND }} />;
  if (lower === "work") return <WorkIcon sx={{ color: BRAND }} />;
  return <FlagIcon sx={{ color: BRAND }} />;
}

/**
 * Shared empty-search surface for desktop and mobile. Recent queries stay on
 * this device; account-backed labeled places are shown when signed in.
 */
export function SearchEmptyState({ onSelectPlace, onSelectRecent, onClearRecent }: Props) {
  const t = useTranslations("search");
  const tSaved = useTranslations("saved");
  const { data: session } = useSession();
  const isSignedIn = !!session?.user?.id;
  const { data: labels, isLoading } = useLabeledPlaces();
  const historyEnabled = useSettingsStore((s) => s.searchHistoryEnabled);
  const recentEntries = useRecentSearchStore((s) => s.entries);
  const recents = historyEnabled ? recentEntries : [];

  // Translate the well-known placeholder labels ("home" → "Home" /
  // "Zuhause", "work" → "Work" / "Arbeit"). Custom labels render verbatim.
  function renderLabel(label: string): string {
    const lower = label.trim().toLowerCase();
    if (lower === "home") return tSaved("home");
    if (lower === "work") return tSaved("work");
    return label;
  }

  if (!isSignedIn && recents.length === 0) {
    return (
      <Box sx={{ px: 2, py: 1.75 }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("emptyStateSignedOut")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ py: 0.25 }}>
      {recents.length > 0 && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              px: 2,
              pt: 0,
              pb: 0,
            }}
          >
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", fontWeight: 600, fontSize: 13 }}
            >
              {t("recentSearches")}
            </Typography>
            <Button
              size="small"
              onClick={onClearRecent}
              aria-label={t("clearHistory")}
              sx={{ fontSize: 13, minWidth: 0, minHeight: 32, px: 0.5, py: 0 }}
            >
              {t("clearHistory")}
            </Button>
          </Box>
          {recents.map((query) => (
            <ListItemButton
              key={query}
              onClick={() => onSelectRecent(query)}
              sx={{ px: 2, py: 1, gap: 2 }}
            >
              <HistoryIcon sx={{ color: "text.secondary", fontSize: 20, ml: 1 }} />
              <Typography variant="body2" noWrap>
                {query}
              </Typography>
            </ListItemButton>
          ))}
        </>
      )}

      {isSignedIn && isLoading && (
        <Box sx={{ px: 2, py: 1 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 2, py: 1.25 }}>
              <Skeleton variant="circular" width={22} height={22} />
              <Box sx={{ flex: 1 }}>
                <Skeleton variant="text" width="55%" height={18} />
                <Skeleton variant="text" width="35%" height={14} />
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {isSignedIn && !isLoading && !labels?.length && recents.length === 0 && (
        <Typography variant="body2" sx={{ color: "text.secondary", px: 2, py: 1.75 }}>
          {t("emptyStateNoLabels")}
        </Typography>
      )}

      {isSignedIn && !!labels?.length && (
        <Typography
          variant="caption"
          sx={{
            display: "block",
            color: "text.secondary",
            fontWeight: 600,
            px: 2,
            pt: 1.5,
            pb: 0.5,
          }}
        >
          {tSaved("labeled")}
        </Typography>
      )}
      {isSignedIn &&
        labels?.map((place) => (
          <ListItemButton
            key={place.id}
            onClick={() => onSelectPlace(place)}
            sx={{ px: 2, py: 1.25, gap: 2 }}
          >
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                bgcolor: "action.hover",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {iconFor(place.label)}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body1" sx={{ fontWeight: 500 }} noWrap>
                {renderLabel(place.label)}
              </Typography>
              <Typography
                variant="body2"
                noWrap
                sx={{
                  color: "text.secondary",
                }}
              >
                {place.address ?? place.name}
              </Typography>
            </Box>
          </ListItemButton>
        ))}
    </Box>
  );
}
