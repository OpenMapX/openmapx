import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import type { ReactNode } from "react";

interface AdminPageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned action(s): buttons, refresh icon, status chip. */
  actions?: ReactNode;
  /** Optional parent route for detail and workflow pages. */
  backHref?: string;
  backLabel?: string;
}

export function AdminPageHeader({
  title,
  subtitle,
  actions,
  backHref,
  backLabel = "Back",
}: AdminPageHeaderProps) {
  return (
    <Stack
      component="header"
      direction={{ xs: "column", sm: "row" }}
      sx={{
        alignItems: { xs: "stretch", sm: "center" },
        justifyContent: "space-between",
        gap: 1.5,
        minHeight: 44,
      }}
    >
      <Stack direction="row" sx={{ gap: 1, alignItems: "center", minWidth: 0 }}>
        {backHref && (
          <IconButton component={Link} href={backHref} aria-label={backLabel}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Stack sx={{ gap: 0.25, minWidth: 0 }}>
          <Typography component="h1" variant="h5" noWrap>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {subtitle}
            </Typography>
          )}
        </Stack>
      </Stack>
      {actions && (
        <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
