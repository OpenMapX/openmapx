"use client";

import StarIcon from "@mui/icons-material/Star";
import StarHalfIcon from "@mui/icons-material/StarHalf";
import StarOutlineIcon from "@mui/icons-material/StarOutlined";
import Box from "@mui/material/Box";

interface Props {
  /** 0..5 rating. */
  value: number;
  size?: number;
}

/** Render a 5-star row with halves. */
export function StarDisplay({ value, size = 18 }: Props) {
  const clamped = Math.max(0, Math.min(5, value));
  const stars: ("full" | "half" | "empty")[] = [];
  for (let i = 1; i <= 5; i++) {
    if (clamped >= i) stars.push("full");
    else if (clamped >= i - 0.5) stars.push("half");
    else stars.push("empty");
  }
  return (
    <Box sx={{ display: "inline-flex", gap: 0.25, lineHeight: 0 }}>
      {stars.map((s, i) => {
        const key = `${i}-${s}`;
        const sx = { fontSize: size, color: s === "empty" ? "action.disabled" : "#FBBC04" };
        if (s === "full") return <StarIcon key={key} sx={sx} />;
        if (s === "half") return <StarHalfIcon key={key} sx={sx} />;
        return <StarOutlineIcon key={key} sx={sx} />;
      })}
    </Box>
  );
}
