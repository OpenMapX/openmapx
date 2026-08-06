"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";

/**
 * The coasting / weak-GPS / awaiting-first-fix notice. `awaitingFix` depends
 * on `status` and `progress`, so this subscribes to them directly rather than
 * taking them as props from a cold parent — otherwise every fix that arrives
 * (clearing `awaitingFix`, or simply refreshing an already-null `progress`)
 * would have to re-render that parent too. It selects the derived boolean
 * itself, not the `progress` object: `progress` is a brand-new object on
 * every accepted fix, but this notice's rendered text never varies with
 * that fix, so a wide subscription would re-render it ~100 times to display
 * an unchanged string. Selecting the boolean lets Zustand's `Object.is`
 * check skip the re-render once `awaitingFix` settles.
 */
export function NavStatusSlot() {
  const t = useTranslations("navigation");
  const awaitingFix = useNavigationStore((s) => s.status !== "arrived" && s.progress === null);
  const coasting = useNavigationStore((s) => s.coasting);
  const weakGps = useNavigationStore((s) => s.weakGps);

  if (!(coasting || weakGps || awaitingFix)) return null;

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        alignSelf: "flex-start",
        bgcolor: "background.paper",
        borderRadius: 2,
        px: 1.5,
        py: 0.5,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {coasting ? t("estimatedPosition") : weakGps ? t("weakGps") : t("waitingForGps")}
      </Typography>
    </Box>
  );
}
