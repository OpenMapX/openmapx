"use client";

import CloseIcon from "@mui/icons-material/Close";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useSearchStore } from "@openmapx/core";

export function SearchResultsPanel() {
  const { results, query, reset } = useSearchStore();

  if (results.length === 0) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        top: 72,
        left: 12,
        width: { xs: "calc(100% - 24px)", sm: 400 },
        maxHeight: "calc(100dvh - 96px)",
        overflowY: "auto",
        borderRadius: "12px",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Results for "{query}"
        </Typography>
        <IconButton size="small" onClick={reset} aria-label="Close results">
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Results list */}
      <List dense disablePadding>
        {results.map((result, i) => (
          <div key={result.id}>
            {i > 0 && <Divider component="li" />}
            <ListItem disablePadding>
              <ListItemButton sx={{ px: 2, py: 1.5 }}>
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <LocationOnIcon sx={{ color: "error.main", fontSize: 20 }} />
                </ListItemIcon>
                <ListItemText
                  primary={result.label}
                  primaryTypographyProps={{ fontSize: 14, fontWeight: 500 }}
                />
              </ListItemButton>
            </ListItem>
          </div>
        ))}
      </List>
    </Paper>
  );
}
