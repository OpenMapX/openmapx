"use client";

import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeliveryDiningOutlinedIcon from "@mui/icons-material/DeliveryDiningOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RestaurantMenuIcon from "@mui/icons-material/RestaurantMenu";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  bareDomain,
  buildDeliveryOpenUrl,
  type DeliveryProviderInfo,
  isFoodPlace,
  resolveOsmMenuUrl,
  useCountryFromCoordinates,
  useDeliveryProviders,
  useRestaurantMenu,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type MouseEvent, type ReactNode, useId, useState } from "react";
import { TEAL } from "@/lib/theme";
import { BrandMark } from "../shared/BrandMark";

/**
 * A clickable detail row matching PlaceOverviewTab's DetailRow styling. Kept
 * separate from DetailRow on purpose: this whole row is a button (onClick +
 * keyboard), carries primary/secondary text plus arbitrary trailing actions,
 * and underlines on hover — folding that interaction model into DetailRow would
 * complicate its many static, non-clickable uses.
 */
function FoodRow({
  icon,
  primary,
  secondary,
  onClick,
  trailing,
  underlineOnHover,
}: {
  icon: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  onClick: () => void;
  trailing?: ReactNode;
  underlineOnHover?: boolean;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: "flex",
        gap: 2,
        alignItems: "center",
        py: 1.25,
        cursor: "pointer",
        mx: -2,
        px: 2,
        "&:hover": { bgcolor: "action.hover" },
        "& .row-trailing": { opacity: 0 },
        "&:hover .row-trailing": { opacity: 1 },
        ...(underlineOnHover && {
          "&:hover .food-primary": { textDecoration: "underline" },
        }),
      }}
    >
      <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography className="food-primary" variant="body2" sx={{ color: "text.primary" }}>
          {primary}
        </Typography>
        {secondary && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {secondary}
          </Typography>
        )}
      </Box>
      {trailing && (
        <Box
          className="row-trailing"
          sx={{ flexShrink: 0, display: "flex", transition: "opacity 0.15s" }}
        >
          {trailing}
        </Box>
      )}
    </Box>
  );
}

/**
 * Restaurant Menu + "Place an order" rows for the place overview. Both are
 * pure hand-offs: the Menu row links to the
 * restaurant's own menu (OSM `website:menu` tag, else a crawl of its site); the
 * order row opens a region-filtered "Continue with" list of delivery platforms,
 * each pre-filled with the restaurant name. Self-hides when nothing applies.
 */
export function PlaceFoodActions({ place }: { place: Place }) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const food = isFoodPlace(place);
  const osmMenuUrl = resolveOsmMenuUrl(place);

  // Crawl the site only when there's no explicit OSM menu tag.
  const { data: crawledMenu } = useRestaurantMenu(
    place.website,
    food && !osmMenuUrl && Boolean(place.website),
  );
  // When the place carries no country, resolve one from its coordinates so the
  // provider list is region-filtered and the deep links target the right
  // country — otherwise every worldwide platform would show on an un-geocoded
  // POI. Only fires for food places that actually lack a country.
  const { data: resolvedCountry } = useCountryFromCoordinates(
    place.coordinates,
    food && !place.countryCode,
  );
  const countryCode = place.countryCode ?? resolvedCountry ?? undefined;
  const { data: providersData } = useDeliveryProviders(countryCode, food);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogTitleId = useId();

  if (!food) return null;

  const menuUrl = osmMenuUrl ?? crawledMenu?.menuUrl ?? null;
  const providers = providersData?.providers ?? [];

  const openMenu = (e?: MouseEvent) => {
    // The whole row and the open-in-new icon both call this. Stop the icon
    // click from *also* bubbling to the row's onClick, which would open the
    // menu twice — Firefox then blocks the second window as a pop-up.
    e?.stopPropagation();
    if (menuUrl) window.open(menuUrl, "_blank", "noopener,noreferrer");
  };
  const copyMenu = (e: MouseEvent) => {
    e.stopPropagation();
    if (!menuUrl) return;
    navigator.clipboard.writeText(menuUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  const openProvider = (provider: DeliveryProviderInfo) => {
    const [lng, lat] = place.coordinates;
    const url = buildDeliveryOpenUrl(provider.id, {
      name: place.name,
      city: place.city,
      countryCode,
      lat,
      lng,
      postcode: place.osmTags?.["addr:postcode"],
      address: place.address,
    });
    window.open(url, "_blank", "noopener,noreferrer");
    setDialogOpen(false);
  };

  if (!menuUrl && providers.length === 0) return null;

  return (
    <>
      {menuUrl && (
        <FoodRow
          icon={<RestaurantMenuIcon sx={{ fontSize: 22 }} />}
          primary={t("menu")}
          secondary={bareDomain(menuUrl)}
          onClick={openMenu}
          underlineOnHover
          trailing={
            <>
              <Tooltip title={t("openMenuLink")}>
                <IconButton
                  size="small"
                  onClick={openMenu}
                  sx={{ color: "text.secondary", p: 0.5 }}
                >
                  <OpenInNewIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={copied ? tc("copied") : tc("copy")}>
                <IconButton
                  size="small"
                  onClick={copyMenu}
                  sx={{ color: "text.secondary", p: 0.5 }}
                >
                  {copied ? (
                    <CheckIcon sx={{ fontSize: 18 }} />
                  ) : (
                    <ContentCopyIcon sx={{ fontSize: 18 }} />
                  )}
                </IconButton>
              </Tooltip>
            </>
          }
        />
      )}
      {providers.length > 0 && (
        <FoodRow
          icon={<DeliveryDiningOutlinedIcon sx={{ fontSize: 22 }} />}
          primary={t("orderDelivery")}
          onClick={() => setDialogOpen(true)}
        />
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby={dialogTitleId}
      >
        <Box sx={{ p: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", mb: 1.5 }}>
            <Typography id={dialogTitleId} variant="h6" sx={{ flex: 1, fontWeight: 600 }}>
              {t("deliveryDialogTitle")}
            </Typography>
            <IconButton size="small" onClick={() => setDialogOpen(false)} aria-label={tc("close")}>
              <CloseIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Box>
          {providers.map((provider) => (
            <Box
              key={provider.id}
              role="button"
              tabIndex={0}
              onClick={() => openProvider(provider)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openProvider(provider);
                }
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                py: 1.25,
                px: 1,
                mx: -1,
                borderRadius: 1.5,
                cursor: "pointer",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <BrandMark branding={{ name: provider.name, color: provider.color }} size={28} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {provider.name}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {provider.domain}
                </Typography>
              </Box>
              <OpenInNewIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
            </Box>
          ))}
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1.5 }}>
            {t("deliveryNote")}
          </Typography>
        </Box>
      </Dialog>
    </>
  );
}
