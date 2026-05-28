"use client";

import AnchorIcon from "@mui/icons-material/Anchor";
import BoltIcon from "@mui/icons-material/Bolt";
import BuildIcon from "@mui/icons-material/Build";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import LocalLaundryServiceIcon from "@mui/icons-material/LocalLaundryService";
import ShowerIcon from "@mui/icons-material/Shower";
import WaterDropIcon from "@mui/icons-material/WaterDrop";
import WcIcon from "@mui/icons-material/Wc";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

interface HarborFacility {
  osmId: string;
  seamarkType: string;
  name?: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

interface HarborDetail {
  harbor: {
    id: number;
    name: string;
    lng: number;
    lat: number;
    category: number;
    type: string;
    wikiUrl?: string;
  };
  facilities: HarborFacility[];
  /**
   * NOAA tide-prediction station within ~5 km, if any. The PlaceTides row
   * (driven by `useTides`) already covers stations within 2 km; this field
   * lets harbors slightly outside that radius surface a soft hint.
   */
  nearestTideStation?: {
    id: string;
    name: string;
    distanceKm: number;
  };
}

interface Props {
  harbourId: string;
  lat: number;
  lng: number;
  name: string;
  /** OpenSeaMap category number for display + cache key parity. */
  category?: number;
}

/**
 * Map facility types — `seamark:type` for OSM nodes, plus a few generic
 * amenity facets the Overpass query pulls in.
 */
const FACILITY_PRESENTATION: Record<
  string,
  { icon: ReactElement; labelKey: string; rank: number }
> = {
  bunker_station: {
    icon: <LocalGasStationIcon fontSize="small" />,
    labelKey: "facilityBunker",
    rank: 0,
  },
  small_craft_facility: {
    icon: <AnchorIcon fontSize="small" />,
    labelKey: "facilitySmallCraft",
    rank: 1,
  },
  berth: { icon: <AnchorIcon fontSize="small" />, labelKey: "facilityBerth", rank: 2 },
  mooring: { icon: <AnchorIcon fontSize="small" />, labelKey: "facilityMooring", rank: 3 },
};

function summarizeFacilityTags(
  tags: Record<string, string>,
  t: ReturnType<typeof useTranslations>,
): { icon: ReactElement; label: string } | null {
  if (tags.amenity === "fuel" || tags["seamark:type"] === "bunker_station") {
    return { icon: <LocalGasStationIcon fontSize="small" />, label: t("facilityFuel") };
  }
  if (tags["service:water"] === "yes" || tags.drinking_water === "yes") {
    return { icon: <WaterDropIcon fontSize="small" />, label: t("facilityWater") };
  }
  if (tags["service:electricity"] === "yes") {
    return { icon: <BoltIcon fontSize="small" />, label: t("facilityElectricity") };
  }
  if (tags.amenity === "shower") {
    return { icon: <ShowerIcon fontSize="small" />, label: t("facilityShower") };
  }
  if (tags.amenity === "laundry") {
    return { icon: <LocalLaundryServiceIcon fontSize="small" />, label: t("facilityLaundry") };
  }
  if (tags.amenity === "toilets") {
    return { icon: <WcIcon fontSize="small" />, label: t("facilityToilets") };
  }
  if (tags.craft === "boatbuilder" || tags.shop === "boat") {
    return { icon: <BuildIcon fontSize="small" />, label: t("facilityRepair") };
  }
  return null;
}

export function PlaceHarborFacilities({ harbourId, lat, lng, name, category }: Props) {
  const t = useTranslations("nautical");
  const registry = useIntegrationRegistry();
  const env = useEnv();
  const [data, setData] = useState<HarborDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const attributionSource = registry
    .get("overlay-nautical")
    ?.dataSources?.find((ds) => ds.sourceId === "openseamap");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      name,
    });
    if (typeof category === "number") {
      params.set("category", String(category));
    }
    const url = `${env.apiUrl.replace(/\/$/, "")}/api/integrations/overlay-nautical/harbor/${encodeURIComponent(harbourId)}?${params.toString()}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error("harbor fetch failed");
        return (await r.json()) as HarborDetail;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [harbourId, lat, lng, name, category, env.apiUrl]);

  const typeLabel = (() => {
    const type = data?.harbor.type ?? "harbour";
    switch (type) {
      case "marina":
        return t("harborMarina");
      case "yacht_harbour":
        return t("harborYachtHarbour");
      case "port":
        return t("harborPort");
      case "anchorage":
        return t("harborAnchorage");
      case "fishing":
        return t("harborFishing");
      default:
        return t("harborGeneric");
    }
  })();

  const facilityRows = (() => {
    if (!data) return [] as Array<{ key: string; icon: ReactElement; label: string }>;
    const map = new Map<string, { icon: ReactElement; label: string }>();
    for (const f of data.facilities) {
      const presentation = FACILITY_PRESENTATION[f.seamarkType];
      if (presentation) {
        map.set(presentation.labelKey, {
          icon: presentation.icon,
          label: t(presentation.labelKey),
        });
      }
      const tagSummary = summarizeFacilityTags(f.tags, t);
      if (tagSummary) {
        map.set(tagSummary.label, tagSummary);
      }
    }
    return Array.from(map.entries()).map(([key, value]) => ({
      key,
      icon: value.icon,
      label: value.label,
    }));
  })();

  return (
    <Box>
      <Divider sx={{ mx: 2, my: 1 }} />
      <Box sx={{ px: 2, py: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1 }}>
          <AnchorIcon sx={{ fontSize: 20, color: "primary.main" }} />
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{typeLabel}</Typography>
        </Box>

        <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1, letterSpacing: 0.4 }}>
          {t("harborFacilitiesTitle")}
        </Typography>

        {loading && (
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {/* Loading state — facilities lookup runs against Overpass and may take a moment. */}…
          </Typography>
        )}

        {!loading && facilityRows.length === 0 && (
          <Typography sx={{ fontSize: 12, color: "text.secondary", fontStyle: "italic" }}>
            {t("facilityNone")}
          </Typography>
        )}

        {!loading && facilityRows.length > 0 && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
              rowGap: 0.75,
              columnGap: 1,
            }}
          >
            {facilityRows.map((row) => (
              <Box key={row.key} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <Box sx={{ color: "text.secondary", display: "flex" }}>{row.icon}</Box>
                <Typography sx={{ fontSize: 12.5, color: "text.primary" }}>{row.label}</Typography>
              </Box>
            ))}
          </Box>
        )}

        {attributionSource && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              mt: 1,
              display: "block",
              fontSize: 10,
            }}
          >
            ©{" "}
            <Link
              href={attributionSource.url}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              {attributionSource.name}
            </Link>
            {attributionSource.license && ` (${attributionSource.license})`}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
