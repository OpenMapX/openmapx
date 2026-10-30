"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import NotAccessibleIcon from "@mui/icons-material/NotAccessible";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { getWheelchairStatus } from "./transitAccessibility";

export function TransitAccessibilityIndicator({ itinerary }: { itinerary: TripItinerary }) {
  const t = useTranslations("directions");
  const [open, setOpen] = useState(false);
  const statuses = itinerary.legs.map((leg) => getWheelchairStatus(leg, itinerary));
  const restricted = statuses.filter((status) => status === "inaccessible").length;
  const unconfirmed = statuses.filter((status) => status === "unconfirmed").length;
  if (restricted + unconfirmed === 0) return null;

  const label = [
    restricted > 0 ? t("wheelchairRestrictedLegs", { count: restricted }) : null,
    unconfirmed > 0 ? t("wheelchairUnconfirmedLegs", { count: unconfirmed }) : null,
  ]
    .filter(Boolean)
    .join(". ");
  const Icon = restricted > 0 ? NotAccessibleIcon : AccessibleIcon;

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Tooltip
        title={label}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        enterTouchDelay={0}
        arrow
      >
        <IconButton
          aria-label={label}
          size="small"
          data-testid="transit-accessibility-summary"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
          sx={{ color: restricted > 0 ? "error.main" : "warning.dark", p: 0.5 }}
        >
          <Icon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </ClickAwayListener>
  );
}
