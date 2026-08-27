"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CopyAllIcon from "@mui/icons-material/CopyAll";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import PlaceIcon from "@mui/icons-material/Place";
import ShareIcon from "@mui/icons-material/Share";
import {
  Box,
  ButtonBase,
  ClickAwayListener,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  MenuList,
  Popover,
  Snackbar,
  Typography,
} from "@mui/material";
import {
  coordinateId,
  createPlace,
  isLiveNavigationStatus,
  PANEL,
  type Place,
  useDirectionsStore,
  useMapClickStore,
  useNavigationStore,
  usePlaceStore,
  useReverseGeocoding,
  useSidebarStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildLocationShareUrl, shareUrl } from "@/lib/deepLink";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { findStylePoiAtPoint, getStylePoiLayerIds, type StylePoiTarget } from "./mapStylePoiTarget";

interface MapContextTarget {
  coordinates: [number, number];
  anchorPosition: { top: number; left: number };
  poi: StylePoiTarget | null;
}

type ActionId = "from" | "to" | "copy" | "details" | "share";
const ACTION_ORDER: ActionId[] = ["from", "to", "copy", "details", "share"];

function formatContextCoordinates([lng, lat]: [number, number]): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function cameFromTouch(event: MouseEvent & { pointerType?: string }): boolean {
  const capabilities = (
    event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }
  ).sourceCapabilities;
  return event.pointerType === "touch" || capabilities?.firesTouchEvents === true;
}

export function MapContextMenu(): React.ReactNode {
  const t = useTranslations("mapContextMenu");
  const locale = useLocale();
  const { mapRef, mapReady, styleVersion } = useMap();
  const [target, setTarget] = useState<MapContextTarget | null>(null);
  const [activeAction, setActiveAction] = useState<ActionId>("from");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyOpensLeft, setCopyOpensLeft] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const targetRef = useRef<MapContextTarget | null>(null);
  const mountedRef = useRef(true);
  const targetGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const menuFocusFrameRef = useRef<number | null>(null);
  const restoreFocusFrameRef = useRef<number | null>(null);
  const actionRefs = useRef<Record<ActionId, HTMLElement | null>>({
    from: null,
    to: null,
    copy: null,
    details: null,
    share: null,
  });
  const copyRowRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      targetGenerationRef.current += 1;
      actionGenerationRef.current += 1;
    };
  }, []);

  const coordinates = target?.coordinates ?? null;
  const { data: reverseGeo } = useReverseGeocoding(coordinates, locale);
  const coordinateLabel = target ? formatContextCoordinates(target.coordinates) : "";
  const title = target?.poi?.name ?? reverseGeo?.city ?? reverseGeo?.address ?? coordinateLabel;
  const address = reverseGeo?.address ?? coordinateLabel;
  const actionLabel = target?.poi?.name ?? reverseGeo?.address ?? coordinateLabel;

  const place = useMemo<Place | null>(() => {
    if (!target) return null;
    if (target.poi) {
      return createPlace({
        primaryScheme: "stylePoi",
        ids: { stylePoi: target.poi.featureId },
        name: target.poi.name,
        address: reverseGeo?.address ?? target.poi.name,
        coordinates: target.poi.coordinates,
        category: target.poi.category,
        rawCategory: target.poi.rawCategory,
      });
    }
    return createPlace({
      primaryScheme: "coordinate",
      ids: { coordinate: coordinateId(target.coordinates) },
      name: title,
      address,
      coordinates: target.coordinates,
    });
  }, [address, reverseGeo?.address, target, title]);

  const restoreCanvasFocus = useCallback(() => {
    if (restoreFocusFrameRef.current !== null) cancelAnimationFrame(restoreFocusFrameRef.current);
    restoreFocusFrameRef.current = requestAnimationFrame(() => {
      mapRef.current?.getCanvas().focus();
      restoreFocusFrameRef.current = null;
    });
  }, [mapRef]);

  const closeMenu = useCallback(() => {
    targetGenerationRef.current += 1;
    actionGenerationRef.current += 1;
    targetRef.current = null;
    setCopyOpen(false);
    setTarget(null);
    restoreCanvasFocus();
  }, [restoreCanvasFocus]);

  useEffect(() => {
    if (!target) return;
    setActiveAction("from");
    if (menuFocusFrameRef.current !== null) cancelAnimationFrame(menuFocusFrameRef.current);
    menuFocusFrameRef.current = requestAnimationFrame(() => {
      actionRefs.current.from?.focus();
      menuFocusFrameRef.current = null;
    });
    return () => {
      if (menuFocusFrameRef.current !== null) {
        cancelAnimationFrame(menuFocusFrameRef.current);
        menuFocusFrameRef.current = null;
      }
    };
  }, [target]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (targetRef.current) {
      closeMenu();
    } else {
      setCopyOpen(false);
      setTarget(null);
      targetGenerationRef.current += 1;
      actionGenerationRef.current += 1;
    }

    const captureTarget = (
      targetCoordinates: [number, number],
      point: maplibregl.PointLike,
      anchorPosition: { top: number; left: number },
    ) => {
      const poiLayerIds = getStylePoiLayerIds(map);
      const poi = findStylePoiAtPoint(map, point, poiLayerIds, INTERACTIVE_LAYER_IDS);
      const nextTarget = { coordinates: targetCoordinates, anchorPosition, poi };
      targetGenerationRef.current += 1;
      actionGenerationRef.current += 1;
      setCopyOpen(false);
      useMapClickStore.getState().setClickedLngLat(null);
      targetRef.current = nextTarget;
      setTarget(nextTarget);
    };

    const onContextMenu = (event: maplibregl.MapMouseEvent) => {
      const originalEvent = event.originalEvent as MouseEvent & { pointerType?: string };
      if (isLiveNavigationStatus(useNavigationStore.getState().status)) {
        originalEvent.preventDefault();
        return;
      }
      if (cameFromTouch(originalEvent)) return;
      originalEvent.preventDefault();
      captureTarget([event.lngLat.lng, event.lngLat.lat], event.point, {
        top: originalEvent.clientY,
        left: originalEvent.clientX,
      });
    };

    const onCanvasKeyDown = (event: KeyboardEvent) => {
      const isContextKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
      if (!isContextKey) return;
      if (isLiveNavigationStatus(useNavigationStore.getState().status)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const center = map.getCenter();
      const point = map.project(center);
      const rect = map.getCanvas().getBoundingClientRect();
      captureTarget([center.lng, center.lat], point, {
        top: rect.top + point.y,
        left: rect.left + point.x,
      });
    };

    const onMoveStart = () => {
      if (targetRef.current) closeMenu();
    };
    const canvas = map.getCanvas();
    map.on("contextmenu", onContextMenu);
    map.on("movestart", onMoveStart);
    canvas.addEventListener("keydown", onCanvasKeyDown);
    return () => {
      map.off("contextmenu", onContextMenu);
      map.off("movestart", onMoveStart);
      canvas.removeEventListener("keydown", onCanvasKeyDown);
      if (menuFocusFrameRef.current !== null) {
        cancelAnimationFrame(menuFocusFrameRef.current);
        menuFocusFrameRef.current = null;
      }
      if (restoreFocusFrameRef.current !== null) {
        cancelAnimationFrame(restoreFocusFrameRef.current);
        restoreFocusFrameRef.current = null;
      }
    };
  }, [closeMenu, mapReady, mapRef, styleVersion]);

  const focusAction = (action: ActionId) => {
    setActiveAction(action);
    actionRefs.current[action]?.focus();
  };

  const openCopyMenu = () => {
    const rect = copyRowRef.current?.getBoundingClientRect();
    const openLeft = rect ? rect.right + 240 + 8 > window.innerWidth : false;
    setCopyOpensLeft(openLeft);
    setCopyOpen(true);
  };

  const handleTopLevelKeyDown = (event: ReactKeyboardEvent) => {
    if (copyOpen) return;
    const current = activeAction;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "ArrowRight" && current === "copy") {
      event.preventDefault();
      openCopyMenu();
      return;
    }
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      (current === "from" || current === "to")
    ) {
      event.preventDefault();
      focusAction(current === "from" ? "to" : "from");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = ACTION_ORDER.indexOf(current);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusAction(ACTION_ORDER[(index + delta + ACTION_ORDER.length) % ACTION_ORDER.length]);
    }
  };

  const chooseRouteEndpoint = (endpoint: "origin" | "destination") => {
    if (!target) return;
    const directions = useDirectionsStore.getState();
    const index = endpoint === "origin" ? 0 : directions.waypoints.length - 1;
    directions.setWaypoint(index, target.coordinates, actionLabel);
    directions.open();
    useSidebarStore.getState().closeDetail();
    useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
    closeMenu();
  };

  const openPlaceDetails = () => {
    if (!place) return;
    usePlaceStore.getState().setSelectedPlace(place);
    const sidebar = useSidebarStore.getState();
    if (!sidebar.activeSidebarId || sidebar.activeSidebarId === PANEL.PLACE) {
      sidebar.closeDetail();
      sidebar.openSidebar(PANEL.PLACE);
    } else {
      sidebar.openDetail(PANEL.PLACE_CARD);
    }
    closeMenu();
  };

  const copyRows = useMemo(() => {
    if (!target) return [];
    const candidates = [
      { label: t("coordinates"), value: coordinateLabel },
      ...(target.poi?.name ? [{ label: t("name"), value: target.poi.name }] : []),
      ...(reverseGeo?.address ? [{ label: t("address"), value: reverseGeo.address }] : []),
    ];
    const values = new Set<string>();
    return candidates.filter(({ value }) => {
      if (values.has(value)) return false;
      values.add(value);
      return true;
    });
  }, [coordinateLabel, reverseGeo?.address, t, target]);

  const copyValue = async (value: string) => {
    const targetGeneration = targetGenerationRef.current;
    const actionGeneration = ++actionGenerationRef.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (
        !mountedRef.current ||
        targetGeneration !== targetGenerationRef.current ||
        actionGeneration !== actionGenerationRef.current
      ) {
        return;
      }
      closeMenu();
      setFeedback(t("copied"));
    } catch {
      if (
        !mountedRef.current ||
        targetGeneration !== targetGenerationRef.current ||
        actionGeneration !== actionGenerationRef.current
      ) {
        return;
      }
      setFeedback(t("copyFailed"));
    }
  };

  const shareLocation = async () => {
    if (!place) return;
    const targetGeneration = targetGenerationRef.current;
    const actionGeneration = ++actionGenerationRef.current;
    const url = buildLocationShareUrl(window.location.href, {
      id: place.id,
      coordinates: place.coordinates,
      name: place.name,
      category: place.category,
      rawCategory: place.rawCategory,
    });
    const result = await shareUrl({ url, title: place.name });
    if (
      !mountedRef.current ||
      targetGeneration !== targetGenerationRef.current ||
      actionGeneration !== actionGenerationRef.current
    ) {
      return;
    }
    if (result === "unavailable") {
      setFeedback(t("shareFailed"));
      return;
    }
    closeMenu();
    if (result === "copied") setFeedback(t("linkCopied"));
  };

  const setActionRef = (action: ActionId) => (node: HTMLElement | null) => {
    actionRefs.current[action] = node;
    if (action === "copy") copyRowRef.current = node;
  };
  const commonActionProps = (action: ActionId) => ({
    role: "menuitem",
    tabIndex: activeAction === action ? 0 : -1,
    ref: setActionRef(action),
    onFocus: () => {
      if (menuFocusFrameRef.current !== null) {
        cancelAnimationFrame(menuFocusFrameRef.current);
        menuFocusFrameRef.current = null;
      }
      setActiveAction(action);
    },
  });

  return (
    <>
      <ClickAwayListener onClickAway={() => target && closeMenu()}>
        <Box component="span" sx={{ display: "contents" }}>
          <Popover
            open={target !== null}
            disableAutoFocus
            disableEnforceFocus
            disableRestoreFocus
            hideBackdrop
            anchorReference="anchorPosition"
            anchorPosition={target?.anchorPosition}
            marginThreshold={8}
            onClose={closeMenu}
            onKeyDown={handleTopLevelKeyDown}
            slotProps={{
              root: { sx: { pointerEvents: "none" } },
              paper: {
                role: "menu",
                "aria-label": t("ariaLabel", { location: title }),
                sx: {
                  width: 304,
                  maxWidth: "calc(100vw - 16px)",
                  borderRadius: "12px",
                  overflow: "visible",
                  pointerEvents: "auto",
                },
              },
            }}
          >
            {target && (
              <Box sx={{ py: 1 }}>
                <Box sx={{ px: 2, py: 1 }}>
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 700,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {title}
                  </Typography>
                  {address !== title && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {address}
                    </Typography>
                  )}
                </Box>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 1,
                    px: 1.5,
                    pb: 1.5,
                  }}
                >
                  <ButtonBase
                    {...commonActionProps("from")}
                    autoFocus
                    aria-label={t("fromHere")}
                    onClick={() => chooseRouteEndpoint("origin")}
                    sx={(theme) => ({
                      minHeight: 44,
                      borderRadius: 999,
                      bgcolor: "action.hover",
                      gap: 1,
                      px: 1.5,
                      "&.Mui-focusVisible": {
                        outline: `2px solid ${theme.palette.primary.main}`,
                        outlineOffset: 2,
                      },
                    })}
                  >
                    <MyLocationIcon fontSize="small" />
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {t("fromHere")}
                    </Typography>
                  </ButtonBase>
                  <ButtonBase
                    {...commonActionProps("to")}
                    aria-label={t("toHere")}
                    onClick={() => chooseRouteEndpoint("destination")}
                    sx={(theme) => ({
                      minHeight: 44,
                      borderRadius: 999,
                      bgcolor: "primary.main",
                      color: "primary.contrastText",
                      gap: 1,
                      px: 1.5,
                      "&.Mui-focusVisible": {
                        outline: `2px solid ${theme.palette.primary.main}`,
                        outlineOffset: 2,
                      },
                    })}
                  >
                    <LocationOnIcon fontSize="small" />
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {t("toHere")}
                    </Typography>
                  </ButtonBase>
                </Box>
                <Divider />
                <MenuList component="div" role="presentation" disablePadding>
                  <MenuItem
                    {...commonActionProps("copy")}
                    aria-haspopup="menu"
                    aria-expanded={copyOpen}
                    onClick={openCopyMenu}
                    onMouseEnter={openCopyMenu}
                    sx={{ minHeight: "44px !important" }}
                  >
                    <ListItemIcon>
                      <CopyAllIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t("copyLocation")}</ListItemText>
                    <ChevronRightIcon fontSize="small" />
                  </MenuItem>
                  <MenuItem
                    {...commonActionProps("details")}
                    onClick={openPlaceDetails}
                    sx={{ minHeight: "44px !important" }}
                  >
                    <ListItemIcon>
                      <PlaceIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t("openPlaceDetails")}</ListItemText>
                  </MenuItem>
                  <MenuItem
                    {...commonActionProps("share")}
                    onClick={() => void shareLocation()}
                    sx={{ minHeight: "44px !important" }}
                  >
                    <ListItemIcon>
                      <ShareIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t("shareLocation")}</ListItemText>
                  </MenuItem>
                </MenuList>
              </Box>
            )}
          </Popover>
          <Menu
            anchorEl={copyRowRef.current}
            open={copyOpen}
            onClose={() => {
              setCopyOpen(false);
              focusAction("copy");
            }}
            autoFocus
            disableEnforceFocus
            disableRestoreFocus
            hideBackdrop
            anchorOrigin={{ vertical: "top", horizontal: copyOpensLeft ? "left" : "right" }}
            transformOrigin={{ vertical: "top", horizontal: copyOpensLeft ? "right" : "left" }}
            slotProps={{
              root: { sx: { pointerEvents: "none" } },
              paper: {
                sx: {
                  minWidth: 240,
                  maxWidth: "calc(100vw - 16px)",
                  pointerEvents: "auto",
                },
              },
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCopyOpen(false);
                focusAction("copy");
              }
            }}
          >
            {copyRows.map((row) => (
              <MenuItem
                key={row.value}
                onClick={() => void copyValue(row.value)}
                sx={{ minHeight: "44px !important" }}
              >
                <ListItemText primary={row.label} secondary={row.value} />
              </MenuItem>
            ))}
          </Menu>
        </Box>
      </ClickAwayListener>
      <Snackbar
        open={feedback !== null}
        message={feedback}
        autoHideDuration={3000}
        onClose={() => setFeedback(null)}
      />
    </>
  );
}
