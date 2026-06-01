"use client";

import CloseIcon from "@mui/icons-material/Close";
import LayersIcon from "@mui/icons-material/Layers";
import Chip from "@mui/material/Chip";
import { useImportedGeometryStore } from "@openmapx/core";

/**
 * Floating chip shown while an imported GPX/GeoJSON/KML overlay is on the map —
 * names the file and lets the user clear the overlay.
 */
export function ImportedGeometryBanner() {
  const imported = useImportedGeometryStore((s) => s.imported);
  const clearImported = useImportedGeometryStore((s) => s.clearImported);

  if (!imported) return null;

  return (
    <Chip
      icon={<LayersIcon />}
      label={imported.name}
      onDelete={clearImported}
      deleteIcon={<CloseIcon />}
      sx={{
        position: "absolute",
        bottom: "calc(24px + var(--omx-safe-bottom))",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1100,
        maxWidth: "min(90vw, 360px)",
        bgcolor: "background.paper",
        boxShadow: 3,
        "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
      }}
    />
  );
}
