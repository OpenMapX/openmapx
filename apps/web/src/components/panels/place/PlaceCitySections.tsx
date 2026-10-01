"use client";

import ApartmentIcon from "@mui/icons-material/Apartment";
import HotelIcon from "@mui/icons-material/Hotel";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { BoundingBox, CategoryPlace, Place } from "@openmapx/core";
import {
  categoryPlaceToPlace,
  createPlace,
  PANEL,
  proxyImageUrl,
  useCategorySearch,
  useCategorySearchStore,
  useNeighborhoods,
  usePlaceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { useInView } from "@/lib/useInView";
import { CityCard, CityCardRow } from "./PlaceCityCards";

interface Props {
  place: Place;
  onNavigateToInfo: () => void;
}

const MAX_HOTEL_CARDS = 10;
/** Half-span (degrees) of a city's centre, where its hotels are looked for: about 3 km each way. */
const CENTRE_HALF_SPAN = 0.03;

const LODGING_TYPE_KEYS: Record<string, "hotel" | "hostel" | "motel" | "guestHouse" | "apartment"> =
  {
    hotel: "hotel",
    hostel: "hostel",
    motel: "motel",
    guest_house: "guestHouse",
    apartment: "apartment",
  };

/**
 * Where a city's hotels are looked for: its centre, within its boundary. A
 * large municipality's whole box (Rome's reaches the sea) holds thousands of
 * lodgings, more than Overpass lists in time, for a row of ten.
 */
export function hotelSearchBox(place: Place): BoundingBox {
  const [lng, lat] = place.coordinates;
  const centre = {
    south: lat - CENTRE_HALF_SPAN,
    north: lat + CENTRE_HALF_SPAN,
    west: lng - CENTRE_HALF_SPAN,
    east: lng + CENTRE_HALF_SPAN,
  };
  if (!place.boundingBox) return centre;
  const [west, south, east, north] = place.boundingBox;
  const inside = {
    south: Math.max(south, centre.south),
    north: Math.min(north, centre.north),
    west: Math.max(west, centre.west),
    east: Math.min(east, centre.east),
  };
  // A point outside its own boundary leaves no overlap; its centre will do.
  return inside.south < inside.north && inside.west < inside.east ? inside : centre;
}

/** Best-effort photo URL from an OSM POI's image tags. */
function osmPhotoUrl(tags?: Record<string, string>): string | undefined {
  const raw = tags?.image;
  if (raw && /^https?:\/\//.test(raw)) return proxyImageUrl(raw);
  return undefined;
}

function QuickFacts({ place, onNavigateToInfo }: Props) {
  const t = useTranslations("place");
  const text = place.wikipediaExtract ?? place.description;
  if (!text) return null;

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        {t("quickFacts")}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.primary",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {text}
      </Typography>
      <ButtonBase
        onClick={onNavigateToInfo}
        sx={{ color: BRAND, fontWeight: 500, fontSize: 14, mt: 0.5, borderRadius: 1 }}
      >
        {t("more")}
      </ButtonBase>
    </Box>
  );
}

function Hotels({ place }: { place: Place }) {
  const t = useTranslations("place");
  const locale = useLocale();
  const bbox = hotelSearchBox(place);
  const { data } = useCategorySearch("hotels", bbox, locale);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { setActiveCategory, setSearchBbox } = useCategorySearchStore();
  const setQuery = useSearchStore((s) => s.setQuery);

  const hotels = data?.results.slice(0, MAX_HOTEL_CARDS) ?? [];
  if (hotels.length === 0) return null;

  const openHotel = (hotel: CategoryPlace) => {
    setSelectedPlace(categoryPlaceToPlace(hotel, "hotels"));
  };

  const viewMore = () => {
    setSelectedPlace(null);
    setActiveCategory("hotels");
    setSearchBbox(bbox);
    setQuery(t("hotels"));
    useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
  };

  return (
    <CityCardRow title={t("hotels")} action={{ label: t("viewMoreHotels"), onClick: viewMore }}>
      {hotels.map((hotel) => (
        <CityCard
          key={hotel.id}
          name={hotel.name}
          subtitle={t(LODGING_TYPE_KEYS[hotel.category ?? ""] ?? "hotel")}
          imageUrl={osmPhotoUrl(hotel.osmTags)}
          placeholder={<HotelIcon sx={{ fontSize: 32 }} />}
          onClick={() => openHotel(hotel)}
        />
      ))}
    </CityCardRow>
  );
}

function Neighborhoods({ place }: { place: Place }) {
  const t = useTranslations("place");
  const locale = useLocale();
  const { data } = useNeighborhoods(place.boundingBox ?? null, locale);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);

  const neighborhoods = data?.neighborhoods ?? [];
  if (neighborhoods.length === 0) return null;

  return (
    <CityCardRow title={t("neighborhoods")}>
      {neighborhoods.map((n) => (
        <CityCard
          key={n.id}
          name={n.name}
          subtitle={n.description}
          imageUrl={n.photoUrl ? proxyImageUrl(n.photoUrl) : undefined}
          placeholder={<ApartmentIcon sx={{ fontSize: 32 }} />}
          onClick={() =>
            setSelectedPlace(
              createPlace({
                primaryScheme: "osm",
                ids: { osm: n.id },
                name: n.name,
                address: n.name,
                coordinates: n.coordinates,
              }),
            )
          }
        />
      ))}
    </CityCardRow>
  );
}

/**
 * Mounts its children only once they scroll near the viewport, so the wrapped
 * section's queries don't fire while it's below the fold (or if the user opens
 * and immediately closes the panel).
 */
function DeferUntilVisible({ children }: { children: ReactNode }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return <div ref={ref}>{inView ? children : null}</div>;
}

/**
 * City panel sections — Quick facts, Hotels and
 * Neighborhoods — rendered only for administrative areas of size city or
 * smaller. Each sub-section self-hides when it has no data. Hotels and
 * Neighborhoods each fire an Overpass query on mount, so they're deferred
 * until visible to avoid paying for them on a quick city-panel glance.
 */
export function PlaceCitySections({ place, onNavigateToInfo }: Props) {
  return (
    <>
      <QuickFacts place={place} onNavigateToInfo={onNavigateToInfo} />
      <DeferUntilVisible>
        <Hotels place={place} />
      </DeferUntilVisible>
      <DeferUntilVisible>
        <Neighborhoods place={place} />
      </DeferUntilVisible>
    </>
  );
}
