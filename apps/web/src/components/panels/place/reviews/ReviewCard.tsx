"use client";

import CopyrightOutlinedIcon from "@mui/icons-material/CopyrightOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import FlagIcon from "@mui/icons-material/Flag";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import VerifiedIcon from "@mui/icons-material/Verified";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { proxyImageUrl, type Review, safeHref } from "@openmapx/core";
import { fingerprintPem } from "@openmapx/mangrove-client";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { StarDisplay } from "./StarDisplay";

/**
 * A review image is safe for CSS only after the backend proxy has rewritten it.
 * The proxy percent-encodes the original URL, so anything it declines to
 * rewrite is dropped instead of being interpolated into a CSS declaration.
 */
function proxiedThumbnailUrl(src: string): string | null {
  const proxied = proxyImageUrl(src);
  return proxied === src ? null : proxied;
}

interface Props {
  review: Review;
  /** Current user's PEM — marks own reviews + enables edit/delete. */
  currentUserPem?: string | null;
  onEdit?: (review: Review) => void;
  onDelete?: (review: Review) => void;
  onReport?: (review: Review) => void;
}

function relativeTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const days = Math.round(diffMs / 86_400_000);
  if (days < 1) {
    const hours = Math.round(diffMs / 3_600_000);
    if (hours < 1) return rtf.format(-Math.round(diffMs / 60_000), "minute");
    return rtf.format(-hours, "hour");
  }
  if (days < 30) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}

/** Deterministic colour from a fingerprint so the same author always looks the same. */
function colorFromFingerprint(fp: string): string {
  let hash = 0;
  for (let i = 0; i < fp.length; i++) hash = (hash * 31 + fp.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

export function ReviewCard({ review, currentUserPem, onEdit, onDelete, onReport }: Props) {
  const t = useTranslations("place");
  const locale = useLocale();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const fp = fingerprintPem(review.author.kid);
  const isOwn = currentUserPem === review.author.kid;
  const displayName = review.author.nickname?.trim() || `User ${fp}`;
  const licenseId = review.metadata?.license ?? "CC-BY-4.0";
  const licenseUrl =
    licenseId === "CC-BY-SA-4.0"
      ? "https://creativecommons.org/licenses/by-sa/4.0/"
      : "https://creativecommons.org/licenses/by/4.0/";
  const hasAction = isOwn ? !!onEdit || !!onDelete : !!onReport;

  return (
    <Box
      sx={{
        py: 2,
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:last-child": { borderBottom: "none" },
      }}
    >
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", mb: 1 }}>
        <Avatar sx={{ bgcolor: colorFromFingerprint(fp), width: 36, height: 36, fontSize: 14 }}>
          {displayName.slice(0, 2).toUpperCase()}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <Typography
              variant="body2"
              noWrap
              sx={{
                fontWeight: 600,
              }}
            >
              {displayName}
            </Typography>
            {isOwn && (
              <Chip
                icon={<VerifiedIcon sx={{ fontSize: 14 }} />}
                label={t("youReviewed")}
                size="small"
                color="primary"
                variant="outlined"
                sx={{ height: 20, "& .MuiChip-label": { px: 0.75, fontSize: 11 } }}
              />
            )}
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.25 }}>
            {review.stars !== undefined && <StarDisplay value={review.stars} size={14} />}
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {relativeTime(review.createdAt, locale)}
            </Typography>
          </Box>
        </Box>
        <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <MoreVertIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>
      {review.opinion && (
        <Typography variant="body2" sx={{ mb: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {review.opinion}
        </Typography>
      )}
      {review.images && review.images.length > 0 && (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
            gap: 0.5,
            mt: 1,
          }}
        >
          {review.images.map((img) => {
            const thumbnailSrc = proxiedThumbnailUrl(img.src);
            if (!thumbnailSrc) return null;
            return (
              <Box
                key={img.src}
                component="a"
                href={safeHref(img.src)}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  aspectRatio: "1 / 1",
                  borderRadius: 1,
                  backgroundImage: `url("${thumbnailSrc}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  display: "block",
                }}
                aria-label={img.label ?? "Review photo"}
              />
            );
          })}
        </Box>
      )}
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {isOwn && onEdit && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              onEdit(review);
            }}
          >
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("editReview")}</ListItemText>
          </MenuItem>
        )}
        {isOwn && onDelete && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              onDelete(review);
            }}
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("deleteReview")}</ListItemText>
          </MenuItem>
        )}
        {!isOwn && onReport && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              onReport(review);
            }}
          >
            <ListItemIcon>
              <FlagIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("reportReview")}</ListItemText>
          </MenuItem>
        )}
        {hasAction && <Divider />}
        <MenuItem
          component="a"
          href={safeHref(licenseUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setMenuAnchor(null)}
        >
          <ListItemIcon>
            <CopyrightOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("reviewLicense", { license: licenseId })}</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
