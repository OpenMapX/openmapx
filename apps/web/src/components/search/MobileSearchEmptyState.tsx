"use client";

import FlagIcon from "@mui/icons-material/Flag";
import HomeIcon from "@mui/icons-material/Home";
import WorkIcon from "@mui/icons-material/Work";
import Box from "@mui/material/Box";
import ListItemButton from "@mui/material/ListItemButton";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { type LabeledPlace, useLabeledPlaces, useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { BRAND } from "@/lib/theme";

interface Props {
  onSelectPlace: (place: LabeledPlace) => void;
}

function iconFor(label: string): React.ReactNode {
  const lower = label.trim().toLowerCase();
  if (lower === "home") return <HomeIcon sx={{ color: BRAND }} />;
  if (lower === "work") return <WorkIcon sx={{ color: BRAND }} />;
  return <FlagIcon sx={{ color: BRAND }} />;
}

/**
 * Empty-state body shown inside the fullscreen mobile search dialog before
 * the user types anything — surfaces the user's labeled places (Home, Work,
 * Saved) so they can be selected with a single tap.
 */
export function MobileSearchEmptyState({ onSelectPlace }: Props) {
  const t = useTranslations("search");
  const tSaved = useTranslations("saved");
  const { data: session } = useSession();
  const isSignedIn = !!session?.user?.id;
  const { data: labels, isLoading } = useLabeledPlaces();

  // Translate the well-known placeholder labels ("home" → "Home" /
  // "Zuhause", "work" → "Work" / "Arbeit"). Custom labels render verbatim.
  function renderLabel(label: string): string {
    const lower = label.trim().toLowerCase();
    if (lower === "home") return tSaved("home");
    if (lower === "work") return tSaved("work");
    return label;
  }

  if (!isSignedIn) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
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

  if (isLoading) {
    return (
      <Box sx={{ p: 2 }}>
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
    );
  }

  if (!labels || labels.length === 0) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("emptyStateNoLabels")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ py: 0.5 }}>
      {labels.map((place) => (
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
