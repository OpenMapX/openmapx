"use client";

import AppsIcon from "@mui/icons-material/Apps";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

export function TopRightControls() {
  return (
    <Box
      sx={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: 1,
        zIndex: 10,
      }}
    >
      <Tooltip title="Google apps" placement="bottom">
        <IconButton
          aria-label="Apps"
          sx={{
            width: 40,
            height: 40,
            "&:hover": { bgcolor: "rgba(0,0,0,0.08)" },
          }}
        >
          <AppsIcon sx={{ fontSize: 22, color: "text.secondary" }} />
        </IconButton>
      </Tooltip>

      <Tooltip title="Account" placement="bottom">
        <Avatar
          component="button"
          aria-label="Account"
          sx={{
            width: 36,
            height: 36,
            bgcolor: "primary.main",
            fontSize: 15,
            fontWeight: 500,
            cursor: "pointer",
            border: "none",
            fontFamily: "inherit",
            boxShadow: 2,
          }}
        >
          U
        </Avatar>
      </Tooltip>
    </Box>
  );
}
