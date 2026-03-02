"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import ShareIcon from "@mui/icons-material/Share";
import StarIcon from "@mui/icons-material/Star";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { usePlaceStore } from "@openmapx/core";

export function PlacePanel() {
  const { selectedPlace, setSelectedPlace } = usePlaceStore();

  if (!selectedPlace) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        bottom: { xs: 0, sm: "auto" },
        top: { xs: "auto", sm: 72 },
        left: { xs: 0, sm: 12 },
        right: { xs: 0, sm: "auto" },
        width: { xs: "100%", sm: 400 },
        maxHeight: { xs: "60dvh", sm: "calc(100dvh - 96px)" },
        overflowY: "auto",
        borderRadius: { xs: "16px 16px 0 0", sm: "12px" },
        zIndex: 10,
      }}
    >
      {/* Header image placeholder */}
      <Box sx={{ height: 160, bgcolor: "grey.200", position: "relative" }}>
        <IconButton
          size="small"
          onClick={() => setSelectedPlace(null)}
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            bgcolor: "background.paper",
            "&:hover": { bgcolor: "background.paper" },
          }}
          aria-label="Close place panel"
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      {/* Content */}
      <Box sx={{ px: 2, py: 2 }}>
        <Typography variant="h6" fontWeight={600} gutterBottom>
          {selectedPlace.name}
        </Typography>

        {selectedPlace.rating && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1 }}>
            <Typography variant="body2" fontWeight={500}>
              {selectedPlace.rating.toFixed(1)}
            </Typography>
            <StarIcon sx={{ fontSize: 16, color: "#FBBC04" }} />
            <Typography variant="body2" color="text.secondary">
              ({selectedPlace.reviewCount?.toLocaleString()})
            </Typography>
          </Box>
        )}

        {selectedPlace.category && (
          <Chip
            label={selectedPlace.category}
            size="small"
            sx={{ mb: 1.5, borderRadius: "4px", fontSize: 12 }}
          />
        )}

        <Typography variant="body2" color="text.secondary" gutterBottom>
          {selectedPlace.address}
        </Typography>
      </Box>

      <Divider />

      {/* Action buttons */}
      <Box
        sx={{
          display: "flex",
          gap: 1,
          px: 2,
          py: 1.5,
          justifyContent: "space-around",
        }}
      >
        <Button
          startIcon={<DirectionsIcon />}
          variant="contained"
          size="small"
          sx={{ flex: 1, borderRadius: "20px" }}
        >
          Directions
        </Button>
        <Button
          startIcon={<ShareIcon />}
          variant="outlined"
          size="small"
          sx={{ flex: 1, borderRadius: "20px" }}
        >
          Share
        </Button>
      </Box>
    </Paper>
  );
}
