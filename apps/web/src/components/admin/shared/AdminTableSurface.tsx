import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

interface AdminTableSurfaceProps {
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  toolbar?: ReactNode;
  pagination?: ReactNode;
}

/**
 * One Material surface for a dataset: context and controls at the top, rows in
 * the middle, pagination at the bottom. Keeping those pieces in one component
 * prevents the detached-footer pattern that had drifted between admin pages.
 */
export function AdminTableSurface({
  children,
  title,
  description,
  toolbar,
  pagination,
}: AdminTableSurfaceProps) {
  const hasHeader = title || description || toolbar;

  return (
    <Paper component="section" variant="outlined" sx={{ overflow: "hidden" }}>
      {hasHeader && (
        <Stack
          direction={{ xs: "column", md: "row" }}
          sx={{
            alignItems: { xs: "stretch", md: "center" },
            gap: 1.5,
            px: 1.5,
            py: 1.25,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          {(title || description) && (
            <Box sx={{ minWidth: 0, mr: { md: "auto" } }}>
              {title && (
                <Typography variant="subtitle1" component="h2">
                  {title}
                </Typography>
              )}
              {description && (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {description}
                </Typography>
              )}
            </Box>
          )}
          {toolbar && <Box sx={{ minWidth: 0, flexGrow: title ? 0 : 1 }}>{toolbar}</Box>}
        </Stack>
      )}
      {children}
      {pagination}
    </Paper>
  );
}
