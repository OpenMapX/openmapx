"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BrokenImageIcon from "@mui/icons-material/BrokenImage";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Modal from "@mui/material/Modal";
import Typography from "@mui/material/Typography";
import {
  type PlacePhoto,
  proxyImageUrl,
  safeHref,
  useMapClickStore,
  usePlacePhotos,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { LocationMinimap } from "@/integration-api/components/LocationMinimap";
import { useMap } from "@/integration-api/map/MapContext";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { PhotoAttribution } from "./PhotoAttribution";

interface Props {
  open: boolean;
  onClose: () => void;
  placeName: string;
  placeId: string;
  lat: number;
  lng: number;
}

export function PlacePhotoGallery(props: Props) {
  const { open, placeId, lat, lng } = props;
  return <PlacePhotoGalleryInner key={`${placeId}:${lat}:${lng}:${open}`} {...props} />;
}

function PlacePhotoGalleryInner({ open, onClose, placeName, placeId, lat, lng }: Props) {
  const tc = useTranslations("common");
  const tp = useTranslations("photoGallery");
  const fmt = useDateTimeFormat();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const { flyTo } = useMap();
  const setClickedLngLat = useMapClickStore((s) => s.setClickedLngLat);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  // Single API call — server handles tag-based + coordinate-based providers + dedup
  const { data: allPhotos = [], isLoading } = usePlacePhotos(lat, lng, {
    name: placeName,
    placeId,
    limit: 30,
    enabled: open,
  });

  const clampedIdx = Math.min(selectedIdx, Math.max(0, allPhotos.length - 1));
  const selectedPhoto = allPhotos[clampedIdx];

  const goNext = useCallback(() => {
    setSelectedIdx((i) => (i < allPhotos.length - 1 ? i + 1 : i));
  }, [allPhotos.length]);

  const goPrev = useCallback(() => {
    setSelectedIdx((i) => (i > 0 ? i - 1 : i));
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, goNext, goPrev, onClose]);

  const minimapCoords = selectedPhoto?.coordinates;

  return (
    <Modal open={open} onClose={onClose} disableAutoFocus>
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          bgcolor: "rgba(0,0,0,0.95)",
          display: "flex",
          flexDirection: "column",
          zIndex: 1400,
        }}
      >
        {/* Top bar */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 2,
            py: 1,
            gap: 1,
            flexShrink: 0,
          }}
        >
          <IconButton onClick={onClose} sx={{ color: "#fff" }} aria-label={tc("close")}>
            <ArrowBackIcon />
          </IconButton>
          <Typography
            variant="subtitle1"
            noWrap
            sx={{
              fontWeight: 600,
              color: "#fff",
              flex: 1,
            }}
          >
            {placeName}
          </Typography>
          <IconButton onClick={onClose} sx={{ color: "#fff" }} aria-label={tc("close")}>
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Main content area */}
        <Box sx={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Thumbnail sidebar */}
          <Box
            sx={{
              width: { xs: 0, md: 240 },
              display: { xs: "none", md: "flex" },
              flexDirection: "column",
              overflow: "auto",
              borderRight: "1px solid rgba(255,255,255,0.1)",
              flexShrink: 0,
              gap: 0.5,
              p: 0.5,
            }}
          >
            {allPhotos.map((photo, idx) => (
              <GalleryThumbnail
                key={photo.url}
                photo={photo}
                isSelected={idx === clampedIdx}
                onClick={() => setSelectedIdx(idx)}
              />
            ))}

            {isLoading && (
              <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                <CircularProgress size={24} sx={{ color: "rgba(255,255,255,0.5)" }} />
              </Box>
            )}
          </Box>

          {/* Main photo viewer */}
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {allPhotos.length === 0 && isLoading ? (
              <CircularProgress size={40} sx={{ color: "#fff" }} />
            ) : allPhotos.length === 0 ? (
              <Typography sx={{ color: "rgba(255,255,255,0.5)" }}>{tp("noPhotos")}</Typography>
            ) : (
              <>
                {selectedPhoto && (
                  <MainImage key={selectedPhoto.url} photo={selectedPhoto} placeName={placeName} />
                )}

                {clampedIdx > 0 && (
                  <IconButton
                    onClick={goPrev}
                    sx={{
                      position: "absolute",
                      left: 16,
                      top: "50%",
                      transform: "translateY(-50%)",
                      bgcolor: "rgba(0,0,0,0.6)",
                      color: "#fff",
                      "&:hover": { bgcolor: "rgba(0,0,0,0.8)" },
                    }}
                    aria-label={tp("previousPhoto")}
                  >
                    <ChevronLeftIcon fontSize="large" />
                  </IconButton>
                )}
                {clampedIdx < allPhotos.length - 1 && (
                  <IconButton
                    onClick={goNext}
                    sx={{
                      position: "absolute",
                      right: 16,
                      top: "50%",
                      transform: "translateY(-50%)",
                      bgcolor: "rgba(0,0,0,0.6)",
                      color: "#fff",
                      "&:hover": { bgcolor: "rgba(0,0,0,0.8)" },
                    }}
                    aria-label={tp("nextPhoto")}
                  >
                    <ChevronRightIcon fontSize="large" />
                  </IconButton>
                )}

                {minimapCoords && (
                  <LocationMinimap
                    lng={minimapCoords[0]}
                    lat={minimapCoords[1]}
                    sx={GALLERY_MINIMAP_SX}
                    onClick={() => {
                      onClose();
                      setSelectedPlace(null);
                      useSidebarStore.getState().closeSidebar();
                      setClickedLngLat([minimapCoords[0], minimapCoords[1]]);
                      flyTo([minimapCoords[0], minimapCoords[1]], 17);
                    }}
                  />
                )}
              </>
            )}

            {/* Bottom info bar */}
            {selectedPhoto && (
              <Box
                sx={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  bgcolor: "rgba(0,0,0,0.7)",
                  px: 2,
                  py: 1.5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 2,
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" sx={{ color: "#fff" }} noWrap>
                    <PhotoAttribution photo={selectedPhoto} />
                  </Typography>
                  {selectedPhoto.capturedAt && (
                    <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.6)" }}>
                      {fmt.date(selectedPhoto.capturedAt)}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                  <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.6)" }}>
                    {clampedIdx + 1} / {allPhotos.length}
                  </Typography>
                  {selectedPhoto.pageUrl && (
                    <Link
                      href={safeHref(selectedPhoto.pageUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{ color: "#fff", display: "flex" }}
                      aria-label={tp("viewOriginal")}
                    >
                      <OpenInNewIcon sx={{ fontSize: 18 }} />
                    </Link>
                  )}
                </Box>
              </Box>
            )}

            {/* Mobile thumbnail strip */}
            {allPhotos.length > 1 && (
              <Box
                sx={{
                  display: { xs: "flex", md: "none" },
                  position: "absolute",
                  bottom: 56,
                  left: 0,
                  right: 0,
                  overflow: "auto",
                  gap: 0.5,
                  px: 1,
                  pb: 0.5,
                }}
              >
                {allPhotos.map((photo, idx) => (
                  <MobileThumbnail
                    key={photo.url}
                    photo={photo}
                    isSelected={idx === clampedIdx}
                    onClick={() => setSelectedIdx(idx)}
                  />
                ))}
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Modal>
  );
}

/** Main viewer image with fallback on error. */
function MainImage({ photo, placeName }: { photo: PlacePhoto; placeName: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          color: "rgba(255,255,255,0.4)",
        }}
      >
        <BrokenImageIcon sx={{ fontSize: 48 }} />
        <Typography variant="body2">Image could not be loaded</Typography>
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={proxyImageUrl(photo.url)}
      alt={photo.author ?? placeName}
      onError={() => setFailed(true)}
      sx={{
        maxWidth: "100%",
        maxHeight: "calc(100% - 80px)",
        objectFit: "contain",
      }}
    />
  );
}

/** Sidebar thumbnail — tries thumbnailUrl, then full url, then placeholder. */
function GalleryThumbnail({
  photo,
  isSelected,
  onClick,
}: {
  photo: PlacePhoto;
  isSelected: boolean;
  onClick: () => void;
}) {
  const registry = useIntegrationRegistry();
  const resolveSourceName = (sid: string) => registry.findDataSource(sid)?.name ?? sid;

  // 0 = try thumbnailUrl, 1 = try full url, 2 = broken
  const [attempt, setAttempt] = useState(0);

  const hasSeparateThumb = Boolean(photo.thumbnailUrl && photo.thumbnailUrl !== photo.url);
  const rawSrc =
    attempt === 0 && hasSeparateThumb
      ? (photo.thumbnailUrl ?? photo.url)
      : attempt <= 1
        ? photo.url
        : null;
  const imgSrc = rawSrc ? proxyImageUrl(rawSrc) : null;

  return (
    <Box
      onClick={onClick}
      sx={{
        cursor: "pointer",
        borderRadius: 1,
        overflow: "hidden",
        border: isSelected ? "2px solid #4fc3f7" : "2px solid transparent",
        flexShrink: 0,
        position: "relative",
        "&:hover": { opacity: 0.85 },
      }}
    >
      {imgSrc ? (
        <Box
          component="img"
          src={imgSrc}
          alt={photo.author ?? ""}
          loading="lazy"
          onError={() => setAttempt((a) => a + 1)}
          sx={{
            width: "100%",
            height: 150,
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <Box
          sx={{
            width: "100%",
            height: 150,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "rgba(255,255,255,0.08)",
          }}
        >
          <BrokenImageIcon sx={{ fontSize: 32, color: "rgba(255,255,255,0.3)" }} />
        </Box>
      )}
      {/* Source badge */}
      <Box
        sx={{
          position: "absolute",
          bottom: 4,
          left: 4,
          bgcolor: "rgba(0,0,0,0.6)",
          borderRadius: 0.5,
          px: 0.5,
          py: 0.25,
        }}
      >
        <Typography sx={{ fontSize: 10, color: "rgba(255,255,255,0.8)", lineHeight: 1 }}>
          {resolveSourceName(photo.source)}
        </Typography>
      </Box>
      {/* Author */}
      {photo.author && imgSrc && (
        <Box sx={{ position: "absolute", bottom: 4, right: 4 }}>
          <Typography
            sx={{
              fontSize: 10,
              color: "rgba(255,255,255,0.7)",
              lineHeight: 1,
              textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            }}
            noWrap
          >
            {photo.author}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

/** Mobile thumbnail with placeholder on error. */
function MobileThumbnail({
  photo,
  isSelected,
  onClick,
}: {
  photo: PlacePhoto;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const hasSeparateThumb = Boolean(photo.thumbnailUrl && photo.thumbnailUrl !== photo.url);
  const rawSrc =
    attempt === 0 && hasSeparateThumb
      ? (photo.thumbnailUrl ?? photo.url)
      : attempt <= 1
        ? photo.url
        : null;
  const imgSrc = rawSrc ? proxyImageUrl(rawSrc) : null;

  return (
    <Box
      onClick={onClick}
      sx={{
        width: 60,
        height: 60,
        flexShrink: 0,
        borderRadius: 0.5,
        overflow: "hidden",
        cursor: "pointer",
        border: isSelected ? "2px solid #4fc3f7" : "2px solid transparent",
      }}
    >
      {imgSrc ? (
        <Box
          component="img"
          src={imgSrc}
          alt=""
          loading="lazy"
          onError={() => setAttempt((a) => a + 1)}
          sx={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <Box
          sx={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "rgba(255,255,255,0.08)",
          }}
        >
          <BrokenImageIcon sx={{ fontSize: 20, color: "rgba(255,255,255,0.3)" }} />
        </Box>
      )}
    </Box>
  );
}

/** Fixed overlay styling for the gallery's capture-location minimap. */
const GALLERY_MINIMAP_SX = {
  position: "absolute",
  bottom: 68,
  right: 16,
  width: 160,
  height: 120,
  borderRadius: 1,
  overflow: "hidden",
  cursor: "pointer",
  border: "2px solid rgba(255,255,255,0.3)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
  display: { xs: "none", md: "block" },
} as const;
