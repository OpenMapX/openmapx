import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

interface AdminPageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned action(s): buttons, refresh icon, status chip. */
  actions?: ReactNode;
}

export function AdminPageHeader({ title, subtitle, actions }: AdminPageHeaderProps) {
  return (
    <Stack
      direction="row"
      sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1 }}
    >
      <Stack sx={{ gap: 0.25 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {subtitle}
          </Typography>
        )}
      </Stack>
      {actions && (
        <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
