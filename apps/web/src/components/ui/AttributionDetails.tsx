"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import type { AttributionDetail } from "@openmapx/core/attribution";
import type { AttributionLogo } from "@openmapx/mobility-core/licensing";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { AttributionEntry } from "./AttributionEntry";
import { AttributionLogos } from "./AttributionNotices";

/** The current contributed notices, directly reachable by keyboard, touch and pointer. */
export function AttributionDetails({
  entries,
  label,
  logos = [],
  iconOnly = false,
}: {
  entries: readonly AttributionDetail[];
  label?: string;
  logos?: readonly AttributionLogo[];
  /** Small image captions retain the same named, keyboard-accessible action. */
  iconOnly?: boolean;
}) {
  const t = useTranslations("footer");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  if (entries.length === 0) return null;
  const title = label ?? t("attributions");
  return (
    <>
      <ButtonBase
        type="button"
        ref={triggerRef}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          // The modal hides its siblings before its focus trap mounts. Release
          // focus first so Chromium can hide it from assistive technology.
          event.currentTarget.blur();
          setOpen(true);
        }}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={iconOnly ? title : undefined}
        sx={{
          color: "inherit",
          font: "inherit",
          fontWeight: 500,
          lineHeight: "inherit",
          cursor: "pointer",
          display: "inline-flex",
          verticalAlign: "middle",
          gap: 0.5,
          position: "relative",
          minHeight: "1em",
          "&::after": {
            content: '""',
            position: "absolute",
            inset: "min(0px, calc((100% - 24px) / 2)) 0",
          },
          minWidth: iconOnly ? 24 : undefined,
          px: iconOnly ? 0.25 : 0.5,
          py: 0,
          borderRadius: 1,
          whiteSpace: "nowrap",
          "&:hover": { bgcolor: "action.hover" },
          "&.Mui-focusVisible": {
            outline: "2px solid currentColor",
            outlineOffset: 2,
          },
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: "1.15em", flexShrink: 0 }} />
        {!iconOnly && title}
      </ButtonBase>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="sm"
        disableRestoreFocus
        slotProps={{
          transition: {
            // MUI removes background hiding before calling the child's exit
            // callback. Restore here, once the trigger is accessible again.
            onExited: () => triggerRef.current?.focus(),
          },
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle id={titleId} sx={{ fontWeight: 600, pb: 2 }}>
          {title}
        </DialogTitle>
        {logos.length > 0 && (
          <Box sx={{ px: 3, pb: 1 }}>
            <AttributionLogos logos={logos} />
          </Box>
        )}
        <DialogContent dividers sx={{ overflowWrap: "anywhere" }}>
          <Box
            component="ul"
            sx={{
              p: 0,
              m: 0,
              listStyle: "none",
              "& li + li": { mt: 2, pt: 2, borderTop: "1px solid", borderColor: "divider" },
              fontSize: "0.875rem",
              lineHeight: 1.6,
            }}
          >
            {entries.map((entry) => (
              <li key={entry.html}>
                <AttributionEntry entry={entry} />
              </li>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{tc("close")}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
