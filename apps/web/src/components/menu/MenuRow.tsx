"use client";

import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import type { ReactNode } from "react";

interface MenuRowProps {
  label: string;
  /** An outlined icon; rows without one (the help and legal links) are text only. */
  icon?: ReactNode;
  /** Trailing hint, such as a keyboard shortcut. */
  hint?: string;
  /** Navigates instead of calling `onClick` alone. */
  href?: string;
  onClick?: () => void;
}

/** One entry of the main menu drawer. */
export function MenuRow({ label, icon, hint, href, onClick }: MenuRowProps) {
  const content = (
    <>
      {icon && (
        <ListItemIcon sx={{ minWidth: 44, color: "text.secondary", "& svg": { fontSize: 22 } }}>
          {icon}
        </ListItemIcon>
      )}
      <ListItemText primary={label} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
      {hint && (
        <Typography component="kbd" sx={{ fontSize: 12, color: "text.secondary", ml: 1 }}>
          {hint}
        </Typography>
      )}
    </>
  );
  return href ? (
    <ListItemButton component={Link} href={href} onClick={onClick} sx={ROW_SX}>
      {content}
    </ListItemButton>
  ) : (
    <ListItemButton onClick={onClick} sx={ROW_SX}>
      {content}
    </ListItemButton>
  );
}

const ROW_SX = { minHeight: 44, px: 2.5 } as const;
