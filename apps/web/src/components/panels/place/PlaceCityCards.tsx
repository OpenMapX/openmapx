"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { BRAND } from "@/lib/theme";

const CARD_WIDTH = 168;
const CARD_IMAGE_HEIGHT = 112;

/**
 * A titled section containing a horizontally-scrolling row of {@link CityCard}s,
 * with an optional centred "view more" action below. Used by the city place
 * panel for Hotels and Neighborhoods.
 */
export function CityCardRow({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.25 }}>
        {title}
      </Typography>
      <Box
        sx={{
          display: "flex",
          gap: 1.5,
          overflowX: "auto",
          // Let cards bleed to the panel edges and scroll past them.
          mx: -2,
          px: 2,
          pb: 0.5,
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        {children}
      </Box>
      {action && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}>
          <ButtonBase
            onClick={action.onClick}
            sx={{ color: BRAND, fontWeight: 500, fontSize: 14, py: 0.5, px: 1, borderRadius: 1 }}
          >
            {action.label}
          </ButtonBase>
        </Box>
      )}
    </Box>
  );
}

/**
 * A single fixed-width card: image (or icon placeholder) on top, a bold name and
 * an optional secondary subtitle below. The whole card is clickable.
 */
export function CityCard({
  imageUrl,
  name,
  subtitle,
  placeholder,
  onClick,
}: {
  imageUrl?: string;
  name: string;
  subtitle?: ReactNode;
  /** Shown centred in the image area when no `imageUrl` is available. */
  placeholder?: ReactNode;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      sx={{
        width: CARD_WIDTH,
        flexShrink: 0,
        display: "block",
        textAlign: "left",
        borderRadius: 2,
        overflow: "hidden",
        border: "1px solid var(--omx-border-light)",
        bgcolor: "background.paper",
        "&:hover": { boxShadow: 2 },
      }}
    >
      <Box
        sx={{
          height: CARD_IMAGE_HEIGHT,
          bgcolor: "action.hover",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.disabled",
        }}
      >
        {imageUrl ? (
          <Box
            component="img"
            src={imageUrl}
            alt={name}
            loading="lazy"
            sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          placeholder
        )}
      </Box>
      <Box sx={{ p: 1 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: "text.primary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </Typography>
        {subtitle && (
          <Typography
            variant="caption"
            component="div"
            sx={{
              color: "text.secondary",
              mt: 0.25,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {subtitle}
          </Typography>
        )}
      </Box>
    </ButtonBase>
  );
}
