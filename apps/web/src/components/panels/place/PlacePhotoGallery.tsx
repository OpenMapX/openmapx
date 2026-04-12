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
  useIntegrationRegistry,
  useMapClickStore,
  usePlacePhotos,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { maptilerStyleUrl } from "@/lib/map";
import { PhotoAttribution } from "./PhotoAttribution";

interface Props {
  open: boolean;
  onClose: () => void;
  placeName: string;
  placeId: string;
  lat: number;
  lng: number;
}

export function PlacePhotoGallery({ open, onClose, placeName, placeId, lat, lng }: Props) {
  const tc = useTranslations("common");
  const tp = useTranslations("photoGallery");
  const locale = useLocale();
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open
  useEffect(() => {
    if (open) setSelectedIdx(0);
  }, [open, lat, lng]);

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
          <Typography variant="subtitle1" fontWeight={600} sx={{ color: "#fff", flex: 1 }} noWrap>
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
                {selectedPhoto && <MainImage photo={selectedPhoto} placeName={placeName} />}

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
                  <GalleryMinimap
                    lng={minimapCoords[0]}
                    lat={minimapCoords[1]}
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
                      {formatDate(selectedPhoto.capturedAt, locale)}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                  <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.6)" }}>
                    {clampedIdx + 1} / {allPhotos.length}
                  </Typography>
                  {selectedPhoto.pageUrl && (
                    <Link
                      href={selectedPhoto.pageUrl}
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

  // Reset failed state when the photo URL changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on url change
  useEffect(() => {
    setFailed(false);
  }, [photo.url]);

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
  const resolveSourceName = (sid: string) =>
    registry
      .getByDomain("photos")
      .flatMap((m) => m.dataSources ?? [])
      .find((d) => d.sourceId === sid)?.name ?? sid;

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

/** Small MapLibre minimap showing the photo capture location. */
function GalleryMinimap({ lng, lat, onClick }: { lng: number; lat: number; onClick?: () => void }) {
  const env = useEnv();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ map: unknown; marker: unknown } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: map created once, coords updated by second effect
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    import("maplibre-gl").then(({ default: maplibregl }) => {
      if (cancelled || !el || !env.maptilerKey) return;

      const map = new maplibregl.Map({
        container: el,
        style: maptilerStyleUrl("bright-v2", env),
        center: [lng, lat],
        zoom: 16,
        interactive: false,
        attributionControl: false,
      });

      const marker = new maplibregl.Marker({ color: "#e53935" }).setLngLat([lng, lat]).addTo(map);

      mapRef.current = { map, marker };
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        const { map } = mapRef.current as { map: { remove: () => void } };
        map.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    const { map, marker } = mapRef.current as {
      map: { flyTo: (opts: { center: [number, number]; duration: number }) => void };
      marker: { setLngLat: (coords: [number, number]) => void };
    };
    marker.setLngLat([lng, lat]);
    map.flyTo({ center: [lng, lat], duration: 300 });
  }, [lng, lat]);

  return (
    <Box
      ref={containerRef}
      onClick={onClick}
      sx={{
        position: "absolute",
        bottom: 68,
        right: 16,
        width: 160,
        height: 120,
        borderRadius: 1,
        overflow: "hidden",
        cursor: onClick ? "pointer" : "default",
        border: "2px solid rgba(255,255,255,0.3)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
        display: { xs: "none", md: "block" },
      }}
    />
  );
}

function formatDate(iso: string, locale?: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale ?? "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
