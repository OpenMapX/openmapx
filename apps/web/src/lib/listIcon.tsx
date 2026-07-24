import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FlagIcon from "@mui/icons-material/Flag";
import StarIcon from "@mui/icons-material/Star";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { BRAND } from "./theme";

const ICON_MAP: Record<string, React.ElementType> = {
  heart: FavoriteIcon,
  flag: FlagIcon,
  star: StarIcon,
  bookmark: BookmarkBorderIcon,
};

export function resolveListIcon(icon: string | null, size = 22): ReactNode {
  if (!icon) {
    return <BookmarkBorderIcon sx={{ color: BRAND, fontSize: size }} />;
  }
  if (icon.charCodeAt(0) > 127) {
    return (
      <Typography component="span" sx={{ fontSize: size - 2, lineHeight: 1 }}>
        {icon}
      </Typography>
    );
  }
  const Ic = ICON_MAP[icon] ?? BookmarkBorderIcon;
  return <Ic sx={{ color: BRAND, fontSize: size }} />;
}
