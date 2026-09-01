"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import AccountBalanceIcon from "@mui/icons-material/AccountBalance";
import ApartmentIcon from "@mui/icons-material/Apartment";
import AttachMoneyIcon from "@mui/icons-material/AttachMoney";
import BabyChangingStationIcon from "@mui/icons-material/BabyChangingStation";
import BusinessIcon from "@mui/icons-material/Business";
import DeckIcon from "@mui/icons-material/Deck";
import DriveEtaIcon from "@mui/icons-material/DriveEta";
import EmailIcon from "@mui/icons-material/Email";
import EventIcon from "@mui/icons-material/Event";
import FacebookIcon from "@mui/icons-material/Facebook";
import GroupIcon from "@mui/icons-material/Group";
import HeightIcon from "@mui/icons-material/Height";
import InstagramIcon from "@mui/icons-material/Instagram";
import LandscapeIcon from "@mui/icons-material/Landscape";
import LinkedInIcon from "@mui/icons-material/LinkedIn";
import LocalShippingIcon from "@mui/icons-material/LocalShipping";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import MeetingRoomIcon from "@mui/icons-material/MeetingRoom";
import MoneyOffIcon from "@mui/icons-material/MoneyOff";
import NotesIcon from "@mui/icons-material/Notes";
import PetsIcon from "@mui/icons-material/Pets";
import PinterestIcon from "@mui/icons-material/Pinterest";
import PrecisionManufacturingIcon from "@mui/icons-material/PrecisionManufacturing";
import RedditIcon from "@mui/icons-material/Reddit";
import RestaurantIcon from "@mui/icons-material/Restaurant";
import SmokeFreeIcon from "@mui/icons-material/SmokeFree";
import SmokingRoomsIcon from "@mui/icons-material/SmokingRooms";
import StairsIcon from "@mui/icons-material/Stairs";
import StarIcon from "@mui/icons-material/Star";
import StorefrontIcon from "@mui/icons-material/Storefront";
import TakeoutDiningIcon from "@mui/icons-material/TakeoutDining";
import TelegramIcon from "@mui/icons-material/Telegram";
import TerrainIcon from "@mui/icons-material/Terrain";
import WaterDropIcon from "@mui/icons-material/WaterDrop";
import WcIcon from "@mui/icons-material/Wc";
import WhatsAppIcon from "@mui/icons-material/WhatsApp";
import WifiIcon from "@mui/icons-material/Wifi";
import WifiOffIcon from "@mui/icons-material/WifiOff";
import XIcon from "@mui/icons-material/X";
import YouTubeIcon from "@mui/icons-material/YouTube";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { safeHref } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  SiBluesky,
  SiFlickr,
  SiMastodon,
  SiThreads,
  SiTiktok,
  SiVimeo,
  SiVk,
} from "react-icons/si";
import { BRAND } from "@/integration-api/runtime/theme";
import { humanizeOsmTagValue } from "@/lib/humanizeOsmTagValue";

/** Language code → country code for emoji flag rendering. */
const LANG_TO_COUNTRY: Record<string, string> = {
  en: "GB",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  pt: "PT",
  nl: "NL",
  pl: "PL",
  ru: "RU",
  ja: "JP",
  zh: "CN",
  ko: "KR",
  ar: "SA",
  cs: "CZ",
  da: "DK",
  sv: "SE",
  fi: "FI",
  el: "GR",
  uk: "UA",
  no: "NO",
  hu: "HU",
  ro: "RO",
  bg: "BG",
  hr: "HR",
  sk: "SK",
  sl: "SI",
  et: "EE",
  lv: "LV",
  lt: "LT",
  tr: "TR",
  vi: "VN",
  th: "TH",
  he: "IL",
  id: "ID",
  ms: "MY",
  ca: "AD",
  ga: "IE",
  eu: "ES",
  gl: "ES",
  cy: "GB",
  sq: "AL",
  sr: "RS",
  bs: "BA",
  mk: "MK",
  ka: "GE",
  hy: "AM",
  az: "AZ",
  kk: "KZ",
  uz: "UZ",
};

function countryToFlag(cc: string): string {
  const upper = cc.toUpperCase();
  return String.fromCodePoint(...Array.from(upper).map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function langFlag(lang: string): string {
  const cc = LANG_TO_COUNTRY[lang.toLowerCase()];
  return cc ? countryToFlag(cc) : lang.toUpperCase();
}

/**
 * All simple (non-multilingual) tag keys this component handles.
 * Used both for rendering and for computing consumed keys.
 */
const CONSUMED_SIMPLE_KEYS = new Set([
  // Identity
  "operator",
  "brand",
  "network",
  // Contact
  "email",
  "contact:email",
  // Access & entry
  "access",
  "wheelchair",
  "fee",
  "charge",
  // Physical
  "indoor",
  "level",
  "locked",
  "surface",
  "ele",
  "height",
  "building:levels",
  // Capacity & rating
  "capacity",
  "stars",
  // Facilities
  "smoking",
  "dog",
  "drinking_water",
  "toilets",
  "toilets:wheelchair",
  "changing_table",
  "shower",
  // Services
  "drive_through",
  "delivery",
  "takeaway",
  "outdoor_seating",
  "internet_access",
  // Equipment
  "manufacturer",
  "model",
  // Cultural
  "cuisine",
  "religion",
  "denomination",
  // Temporal
  "start_date",
  "heritage",
  "min_age",
  // Linked metadata (consumed so they don't clutter "Other details")
  "operator:wikidata",
  "operator:wikipedia",
  "brand:wikidata",
  "brand:wikipedia",
  // Contact alternatives (consumed by overview tab detail rows)
  "contact:phone",
  "contact:website",
  // Review platform links (consumed by Reviews tab)
  "contact:tripadvisor",
  "contact:yelp",
  "ref:yelp",
  // Photos (consumed by gallery)
  "image",
  // Social media (consumed by social row)
  "contact:facebook",
  "contact:instagram",
  "contact:twitter",
  "contact:youtube",
  "contact:linkedin",
  "contact:pinterest",
  "contact:telegram",
  "contact:whatsapp",
  "contact:reddit",
  "contact:tiktok",
  "contact:mastodon",
  "contact:bluesky",
  "contact:vk",
  "contact:threads",
  "contact:flickr",
  "contact:vimeo",
]);

/** Social media platform definitions: OSM tag key → label, icon, URL resolver. */
const SOCIAL_PLATFORMS: Array<{
  tagKey: string;
  label: string;
  icon: ReactNode;
  toUrl: (v: string) => string;
}> = [
  {
    tagKey: "contact:facebook",
    label: "Facebook",
    icon: <FacebookIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.facebook.com/${v}`),
  },
  {
    tagKey: "contact:instagram",
    label: "Instagram",
    icon: <InstagramIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.instagram.com/${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:twitter",
    label: "X",
    icon: <XIcon sx={{ fontSize: 18 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://x.com/${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:youtube",
    label: "YouTube",
    icon: <YouTubeIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.youtube.com/${v}`),
  },
  {
    tagKey: "contact:linkedin",
    label: "LinkedIn",
    icon: <LinkedInIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.linkedin.com/company/${v}`),
  },
  {
    tagKey: "contact:telegram",
    label: "Telegram",
    icon: <TelegramIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://t.me/${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:whatsapp",
    label: "WhatsApp",
    icon: <WhatsAppIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://wa.me/${v.replace(/[^0-9]/g, "")}`),
  },
  {
    tagKey: "contact:pinterest",
    label: "Pinterest",
    icon: <PinterestIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.pinterest.com/${v}`),
  },
  {
    tagKey: "contact:reddit",
    label: "Reddit",
    icon: <RedditIcon sx={{ fontSize: 20 }} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.reddit.com/r/${v}`),
  },
  {
    tagKey: "contact:tiktok",
    label: "TikTok",
    icon: <SiTiktok size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.tiktok.com/@${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:mastodon",
    label: "Mastodon",
    icon: <SiMastodon size={18} />,
    toUrl: (v) =>
      v.startsWith("http")
        ? v
        : `https://${v.replace(/^@[^@]+@/, "")}/@${v.replace(/@[^@]+$/, "").replace(/^@/, "")}`,
  },
  {
    tagKey: "contact:bluesky",
    label: "Bluesky",
    icon: <SiBluesky size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://bsky.app/profile/${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:threads",
    label: "Threads",
    icon: <SiThreads size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.threads.net/@${v.replace(/^@/, "")}`),
  },
  {
    tagKey: "contact:vk",
    label: "VK",
    icon: <SiVk size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://vk.com/${v}`),
  },
  {
    tagKey: "contact:flickr",
    label: "Flickr",
    icon: <SiFlickr size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://www.flickr.com/photos/${v}`),
  },
  {
    tagKey: "contact:vimeo",
    label: "Vimeo",
    icon: <SiVimeo size={18} />,
    toUrl: (v) => (v.startsWith("http") ? v : `https://vimeo.com/${v}`),
  },
];

/** Prefixed description-style tag patterns that carry multilingual values. */
const MULTILINGUAL_BASE_KEYS = ["description", "note"] as const;

/** Test whether a key is a multilingual tag consumed by this component. */
function isMultilingualKey(key: string): boolean {
  for (const mk of [...MULTILINGUAL_BASE_KEYS, "location"] as const) {
    if (
      key === mk ||
      new RegExp(`^${mk}:[a-z]{2,3}$`).test(key) ||
      new RegExp(`^[^:]+:${mk}$`).test(key) ||
      new RegExp(`^[^:]+:${mk}:[a-z]{2,3}$`).test(key)
    ) {
      return true;
    }
  }
  return false;
}

interface MultilingualEntry {
  label: string;
  defaultValue?: string;
  translations: Array<{ lang: string; flag: string; value: string }>;
}

function collectMultilingualEntries(tags: Record<string, string>): MultilingualEntry[] {
  const groups = new Map<string, { defaultValue?: string; translations: Map<string, string> }>();

  for (const [key, value] of Object.entries(tags)) {
    let baseKey: string | null = null;
    let lang: string | null = null;

    for (const mk of MULTILINGUAL_BASE_KEYS) {
      if (key === mk) {
        baseKey = mk;
        break;
      }
      const m = key.match(new RegExp(`^${mk}:([a-z]{2,3})$`));
      if (m) {
        baseKey = mk;
        lang = m[1];
        break;
      }
    }

    if (!baseKey) {
      for (const mk of [...MULTILINGUAL_BASE_KEYS, "location"] as const) {
        if (new RegExp(`^[^:]+:${mk}$`).test(key)) {
          baseKey = key;
          break;
        }
        const m = key.match(new RegExp(`^([^:]+):${mk}:([a-z]{2,3})$`));
        if (m) {
          baseKey = `${m[1]}:${mk}`;
          lang = m[2];
          break;
        }
      }
    }

    if (!baseKey) continue;

    let group = groups.get(baseKey);
    if (!group) {
      group = { translations: new Map() };
      groups.set(baseKey, group);
    }
    if (lang) group.translations.set(lang, value);
    else group.defaultValue = value;
  }

  const entries: MultilingualEntry[] = [];
  for (const [baseKey, group] of groups) {
    if (!group.defaultValue && group.translations.size === 0) continue;
    const translations = Array.from(group.translations.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([l, v]) => ({ lang: l, flag: langFlag(l), value: v }));
    entries.push({ label: formatKey(baseKey), defaultValue: group.defaultValue, translations });
  }
  return entries;
}

function formatKey(key: string): string {
  return key
    .replace(/^[^:]+:/, (prefix) => `${prefix.slice(0, -1).replace(/_/g, " ")} · `)
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Capitalize an OSM value for display (e.g. "italian" → "Italian"). */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a Wikipedia or Wikidata tag value to a URL.
 * Wikipedia values are "lang:Title" (e.g. "de:Deutscher Bundestag").
 * Wikidata values are "Q123456".
 * Priority: Wikipedia > Wikidata (more user-friendly).
 */
function resolveLinkedUrl(tags: Record<string, string>, prefix: string): string | null {
  const wp = tags[`${prefix}:wikipedia`];
  if (wp) {
    const colon = wp.indexOf(":");
    if (colon > 0) {
      const lang = wp.slice(0, colon);
      const title = wp.slice(colon + 1);
      return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    }
  }
  const wd = tags[`${prefix}:wikidata`];
  if (wd) return `https://www.wikidata.org/wiki/${encodeURIComponent(wd)}`;
  return null;
}

/** Format semicolon-separated OSM values (e.g. "italian;pizza" → "Italian, Pizza"). */
function formatList(s: string): string {
  return s
    .split(";")
    .map((v) => capitalize(v.trim().replace(/_/g, " ")))
    .join(", ");
}

/** Regex to detect URLs in free text. */
const URL_RE = /(https?:\/\/[^\s,;)>\]]+)/g;

/** Render text with embedded URLs as clickable links. */
function Linkified({ text, color = "inherit" }: { text: string; color?: string }) {
  // `String.split` with a capturing regex emits empty strings when a match
  // sits at the start/end of the input (e.g. text === "https://example.com"
  // → ["", "https://example.com", ""]). Two empty `<span key="">` siblings
  // tripped React's duplicate-key warning, so drop the empties up front.
  // Also use index keys + a startsWith check instead of `URL_RE.test(part)`
  // because the regex carries `g`, and stateful `lastIndex` across `.test()`
  // calls can misclassify parts.
  const parts = text.split(URL_RE).filter((p) => p.length > 0);
  const hasUrl = parts.some(isHttpUrl);
  if (!hasUrl) {
    return <>{text}</>;
  }
  return (
    <>
      {parts.map((part, i) => {
        // parts is derived deterministically from `text` via String.prototype.split,
        // never mutated and never reordered, so `${i}-${part}` is a stable key.
        const key = `${i}-${part}`;
        return isHttpUrl(part) ? (
          <Link
            key={key}
            href={safeHref(part)}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            sx={{ color, wordBreak: "break-all" }}
          >
            {part}
          </Link>
        ) : (
          <span key={key}>{part}</span>
        );
      })}
    </>
  );
}

function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function DetailItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.75 }}>
      <Box sx={{ color: BRAND, flexShrink: 0, display: "flex", fontSize: 20 }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

function BoolItem({
  icon,
  iconNo,
  label,
  value,
  showNo = false,
}: {
  icon: ReactNode;
  iconNo?: ReactNode;
  label: string;
  value: string;
  showNo?: boolean;
}) {
  const isNo = value === "no";
  if (isNo && !showNo) return null;
  return (
    <DetailItem icon={isNo && iconNo ? iconNo : icon}>
      <Typography variant="body2" color={isNo ? "text.secondary" : "text.primary"}>
        {label}
      </Typography>
    </DetailItem>
  );
}

/**
 * Set of all OSM tag keys consumed by this component.
 * Used by PlaceInfoTab to exclude them from all sections.
 */
export function getOverviewConsumedKeys(tags: Record<string, string>): Set<string> {
  const consumed = new Set<string>();
  for (const key of Object.keys(tags)) {
    if (CONSUMED_SIMPLE_KEYS.has(key) || isMultilingualKey(key) || /^image(:\d+)?$/.test(key)) {
      consumed.add(key);
    }
  }
  return consumed;
}

interface Props {
  osmTags: Record<string, string>;
}

export function PlaceTagDetails({ osmTags }: Props) {
  const t = useTranslations("place");

  const tag = (k: string) => osmTags[k];

  const operator = humanizeOsmTagValue(tag("operator") ?? "") || tag("operator");
  const brand = humanizeOsmTagValue(tag("brand") ?? "") || tag("brand");
  const network = humanizeOsmTagValue(tag("network") ?? "") || tag("network");
  const email = tag("email") ?? tag("contact:email");
  const wheelchair = tag("wheelchair");
  const access = tag("access");
  const fee = tag("fee");
  const charge = tag("charge");
  const indoor = tag("indoor");
  const level = tag("level");
  const locked = tag("locked");
  const capacity = tag("capacity");
  const stars = tag("stars");
  const ele = tag("ele");
  const surface = tag("surface");
  const height = tag("height");
  const buildingLevels = tag("building:levels");
  const smoking = tag("smoking");
  const dog = tag("dog");
  const driveThrough = tag("drive_through");
  const delivery = tag("delivery");
  const takeaway = tag("takeaway");
  const outdoorSeating = tag("outdoor_seating");
  const internetAccess = tag("internet_access");
  const drinkingWater = tag("drinking_water");
  const toilets = tag("toilets");
  const toiletsWheelchair = tag("toilets:wheelchair");
  const changingTable = tag("changing_table");
  const shower = tag("shower");
  const manufacturer = tag("manufacturer");
  const model = tag("model");
  const cuisine = tag("cuisine");
  const religion = tag("religion");
  const denomination = tag("denomination");
  const startDate = tag("start_date");
  const heritage = tag("heritage");
  const minAge = tag("min_age");

  const multilingualEntries = collectMultilingualEntries(osmTags);

  const socialLinks = SOCIAL_PLATFORMS.filter((p) => osmTags[p.tagKey]).map((p) => ({
    label: p.label,
    icon: p.icon,
    url: p.toUrl(osmTags[p.tagKey]),
  }));

  const hasAny =
    operator ||
    brand ||
    network ||
    email ||
    wheelchair ||
    access ||
    fee ||
    charge ||
    indoor ||
    level ||
    locked ||
    capacity ||
    stars ||
    ele ||
    surface ||
    height ||
    buildingLevels ||
    smoking ||
    dog ||
    driveThrough ||
    delivery ||
    takeaway ||
    outdoorSeating ||
    internetAccess ||
    drinkingWater ||
    toilets ||
    changingTable ||
    shower ||
    manufacturer ||
    model ||
    cuisine ||
    religion ||
    denomination ||
    startDate ||
    heritage ||
    minAge ||
    multilingualEntries.length > 0 ||
    socialLinks.length > 0;

  if (!hasAny) return null;

  // Wheelchair config
  const wheelchairCfg: Record<string, { color: string; labelKey: string }> = {
    yes: { color: "success.main", labelKey: "wheelchairYes" },
    designated: { color: "success.main", labelKey: "wheelchairDesignated" },
    limited: { color: "warning.main", labelKey: "wheelchairLimited" },
    no: { color: "text.secondary", labelKey: "wheelchairNo" },
  };
  const wc = wheelchair ? wheelchairCfg[wheelchair] : null;

  // Access config
  const openIcon = <LockOpenIcon sx={{ fontSize: 20 }} />;
  const restrictedIcon = <LockIcon sx={{ fontSize: 20, color: "text.secondary" }} />;
  const accessCfg: Record<string, { icon: ReactNode; labelKey: string }> = {
    yes: { icon: openIcon, labelKey: "accessPublic" },
    public: { icon: openIcon, labelKey: "accessPublic" },
    designated: { icon: openIcon, labelKey: "accessDesignated" },
    permissive: { icon: openIcon, labelKey: "accessPermissive" },
    discouraged: { icon: openIcon, labelKey: "accessDiscouraged" },
    customers: { icon: restrictedIcon, labelKey: "accessCustomers" },
    permit: { icon: restrictedIcon, labelKey: "accessPermit" },
    destination: { icon: restrictedIcon, labelKey: "accessDestination" },
    delivery: { icon: restrictedIcon, labelKey: "accessDelivery" },
    agricultural: { icon: restrictedIcon, labelKey: "accessAgricultural" },
    forestry: { icon: restrictedIcon, labelKey: "accessForestry" },
    military: { icon: restrictedIcon, labelKey: "accessMilitary" },
    private: { icon: restrictedIcon, labelKey: "accessPrivate" },
    no: { icon: restrictedIcon, labelKey: "accessNo" },
  };
  const ac = access ? accessCfg[access] : null;

  // Collect grid items to determine whether to render the grid
  const gridItems: ReactNode[] = [];

  if (indoor) {
    gridItems.push(
      <DetailItem key="indoor" icon={<MeetingRoomIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {indoor === "yes" ? t("indoor") : t("outdoor")}
        </Typography>
      </DetailItem>,
    );
  }

  if (level) {
    gridItems.push(
      <DetailItem key="level" icon={<StairsIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {t("level")} {level}
        </Typography>
      </DetailItem>,
    );
  }

  if (locked) {
    gridItems.push(
      <DetailItem
        key="locked"
        icon={
          locked === "yes" ? (
            <LockIcon sx={{ fontSize: 20 }} />
          ) : (
            <LockOpenIcon sx={{ fontSize: 20 }} />
          )
        }
      >
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {locked === "yes" ? t("locked") : t("unlocked")}
        </Typography>
      </DetailItem>,
    );
  }

  if (capacity) {
    gridItems.push(
      <DetailItem key="capacity" icon={<GroupIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {t("capacity")} {capacity}
        </Typography>
      </DetailItem>,
    );
  }

  if (stars) {
    const n = parseInt(stars, 10);
    const display = !Number.isNaN(n) && n <= 7 ? "★".repeat(n) : `${stars} ★`;
    gridItems.push(
      <DetailItem key="stars" icon={<StarIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {display}
        </Typography>
      </DetailItem>,
    );
  }

  if (ele) {
    gridItems.push(
      <DetailItem key="ele" icon={<LandscapeIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {ele} m
        </Typography>
      </DetailItem>,
    );
  }

  if (surface) {
    gridItems.push(
      <DetailItem key="surface" icon={<TerrainIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {capitalize(surface.replace(/_/g, " "))}
        </Typography>
      </DetailItem>,
    );
  }

  if (height) {
    gridItems.push(
      <DetailItem key="height" icon={<HeightIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {height} m
        </Typography>
      </DetailItem>,
    );
  }

  if (buildingLevels) {
    gridItems.push(
      <DetailItem key="building:levels" icon={<ApartmentIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {buildingLevels} {t("floors")}
        </Typography>
      </DetailItem>,
    );
  }

  if (smoking) {
    const smokingLabels: Record<string, string> = {
      yes: "smokingYes",
      no: "smokingNo",
      outside: "smokingOutside",
      separated: "smokingSeparated",
      isolated: "smokingIsolated",
    };
    const labelKey = smokingLabels[smoking];
    gridItems.push(
      <DetailItem
        key="smoking"
        icon={
          smoking === "no" ? (
            <SmokeFreeIcon sx={{ fontSize: 20 }} />
          ) : (
            <SmokingRoomsIcon sx={{ fontSize: 20 }} />
          )
        }
      >
        <Typography variant="body2" color={smoking === "no" ? "text.secondary" : "text.primary"}>
          {labelKey ? t(labelKey) : capitalize(smoking)}
        </Typography>
      </DetailItem>,
    );
  }

  if (dog) {
    const dogLabels: Record<string, string> = {
      yes: "dogYes",
      no: "dogNo",
      leashed: "dogLeashed",
    };
    const labelKey = dogLabels[dog];
    gridItems.push(
      <DetailItem
        key="dog"
        icon={
          <PetsIcon sx={{ fontSize: 20, color: dog === "no" ? "text.secondary" : undefined }} />
        }
      >
        <Typography variant="body2" color={dog === "no" ? "text.secondary" : "text.primary"}>
          {labelKey ? t(labelKey) : capitalize(dog)}
        </Typography>
      </DetailItem>,
    );
  }

  if (driveThrough === "yes") {
    gridItems.push(
      <BoolItem
        key="drive_through"
        icon={<DriveEtaIcon sx={{ fontSize: 20 }} />}
        label={t("driveThrough")}
        value="yes"
      />,
    );
  }

  if (delivery === "yes") {
    gridItems.push(
      <BoolItem
        key="delivery"
        icon={<LocalShippingIcon sx={{ fontSize: 20 }} />}
        label={t("delivery")}
        value="yes"
      />,
    );
  }

  if (takeaway) {
    const takeawayLabels: Record<string, string> = {
      yes: "takeawayYes",
      only: "takeawayOnly",
    };
    const labelKey = takeawayLabels[takeaway];
    if (labelKey) {
      gridItems.push(
        <DetailItem key="takeaway" icon={<TakeoutDiningIcon sx={{ fontSize: 20 }} />}>
          <Typography
            variant="body2"
            sx={{
              color: "text.primary",
            }}
          >
            {t(labelKey)}
          </Typography>
        </DetailItem>,
      );
    }
  }

  if (outdoorSeating === "yes") {
    gridItems.push(
      <BoolItem
        key="outdoor_seating"
        icon={<DeckIcon sx={{ fontSize: 20 }} />}
        label={t("outdoorSeating")}
        value="yes"
      />,
    );
  }

  if (internetAccess) {
    const isNo = internetAccess === "no";
    gridItems.push(
      <DetailItem
        key="internet_access"
        icon={
          isNo ? (
            <WifiOffIcon sx={{ fontSize: 20, color: "text.secondary" }} />
          ) : (
            <WifiIcon sx={{ fontSize: 20 }} />
          )
        }
      >
        <Typography variant="body2" color={isNo ? "text.secondary" : "text.primary"}>
          {isNo ? t("noWifi") : t("wifiAvailable")}
        </Typography>
      </DetailItem>,
    );
  }

  if (drinkingWater === "yes") {
    gridItems.push(
      <BoolItem
        key="drinking_water"
        icon={<WaterDropIcon sx={{ fontSize: 20 }} />}
        label={t("drinkingWater")}
        value="yes"
      />,
    );
  }

  if (toilets === "yes" || toiletsWheelchair) {
    const twLabels: Record<string, string> = {
      yes: "toiletsWheelchairYes",
      designated: "toiletsWheelchairDesignated",
      limited: "toiletsWheelchairLimited",
      no: "toiletsWheelchairNo",
    };
    const twKey = toiletsWheelchair ? twLabels[toiletsWheelchair] : null;
    gridItems.push(
      <DetailItem key="toilets" icon={<WcIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {t("toilets")}
          {twKey && (
            <Typography
              component="span"
              variant="body2"
              color={
                toiletsWheelchair === "no"
                  ? "text.secondary"
                  : toiletsWheelchair === "limited"
                    ? "warning.main"
                    : "success.main"
              }
            >
              {" · "}
              {t(twKey)}
            </Typography>
          )}
        </Typography>
      </DetailItem>,
    );
  }

  if (changingTable === "yes") {
    gridItems.push(
      <BoolItem
        key="changing_table"
        icon={<BabyChangingStationIcon sx={{ fontSize: 20 }} />}
        label={t("changingTable")}
        value="yes"
      />,
    );
  }

  if (shower === "yes") {
    gridItems.push(
      <BoolItem
        key="shower"
        icon={<WaterDropIcon sx={{ fontSize: 20 }} />}
        label={t("shower")}
        value="yes"
      />,
    );
  }

  if (startDate) {
    gridItems.push(
      <DetailItem key="start_date" icon={<EventIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {startDate}
        </Typography>
      </DetailItem>,
    );
  }

  if (heritage) {
    const heritageLabels: Record<string, string> = {
      "1": "heritageWorld",
      "2": "heritageNational",
      "3": "heritageRegional",
      yes: "heritageYes",
    };
    const labelKey = heritageLabels[heritage];
    gridItems.push(
      <DetailItem key="heritage" icon={<AccountBalanceIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {labelKey ? t(labelKey) : t("heritageYes")}
        </Typography>
      </DetailItem>,
    );
  }

  if (minAge) {
    gridItems.push(
      <DetailItem key="min_age" icon={<GroupIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {t("minAge", { age: minAge })}
        </Typography>
      </DetailItem>,
    );
  }

  // Manufacturer + model: show combined when both, or just one
  if (manufacturer && model) {
    gridItems.push(
      <DetailItem key="mfg" icon={<PrecisionManufacturingIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          noWrap
          sx={{
            color: "text.primary",
          }}
        >
          {manufacturer} · {model}
        </Typography>
      </DetailItem>,
    );
  } else if (manufacturer || model) {
    gridItems.push(
      <DetailItem key="mfg" icon={<PrecisionManufacturingIcon sx={{ fontSize: 20 }} />}>
        <Typography
          variant="body2"
          noWrap
          sx={{
            color: "text.primary",
          }}
        >
          {manufacturer ?? model}
        </Typography>
      </DetailItem>,
    );
  }

  return (
    <>
      <Divider sx={{ mx: 2, my: 1 }} />
      <Box sx={{ px: 2, py: 0.5 }}>
        {/* Operator */}
        {operator &&
          (() => {
            const url = resolveLinkedUrl(osmTags, "operator");
            return (
              <DetailItem icon={<BusinessIcon sx={{ fontSize: 20 }} />}>
                {url ? (
                  <Link
                    href={safeHref(url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                    underline="hover"
                    sx={{ color: "text.primary" }}
                  >
                    {operator}
                  </Link>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.primary",
                    }}
                  >
                    {operator}
                  </Typography>
                )}
              </DetailItem>
            );
          })()}

        {/* Brand / Network */}
        {(brand || network) &&
          !(brand && brand === operator) &&
          (() => {
            const url = resolveLinkedUrl(osmTags, "brand");
            const label =
              brand && network && brand !== network ? `${brand} (${network})` : (brand ?? network);
            return (
              <DetailItem icon={<StorefrontIcon sx={{ fontSize: 20 }} />}>
                {url ? (
                  <Link
                    href={safeHref(url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                    underline="hover"
                    sx={{ color: "text.primary" }}
                  >
                    {label}
                  </Link>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.primary",
                    }}
                  >
                    {label}
                  </Typography>
                )}
              </DetailItem>
            );
          })()}

        {/* Email */}
        {email && (
          <DetailItem icon={<EmailIcon sx={{ fontSize: 20 }} />}>
            <Link
              href={`mailto:${email}`}
              variant="body2"
              underline="hover"
              sx={{ color: "text.primary" }}
            >
              {email}
            </Link>
          </DetailItem>
        )}

        {/* Wheelchair */}
        {wheelchair && (
          <DetailItem
            icon={<AccessibleIcon sx={{ fontSize: 20, color: wc?.color ?? "text.secondary" }} />}
          >
            <Typography variant="body2" color={wc?.color ?? "text.primary"}>
              {wc ? t(wc.labelKey) : capitalize(wheelchair)}
            </Typography>
          </DetailItem>
        )}

        {/* Access */}
        {access && (
          <DetailItem icon={ac?.icon ?? <LockOpenIcon sx={{ fontSize: 20 }} />}>
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {ac ? t(ac.labelKey) : capitalize(access)}
            </Typography>
          </DetailItem>
        )}

        {/* Fee + Charge */}
        {(fee || charge) && (
          <DetailItem
            icon={
              fee === "no" ? (
                <MoneyOffIcon sx={{ fontSize: 20 }} />
              ) : (
                <AttachMoneyIcon sx={{ fontSize: 20 }} />
              )
            }
          >
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {fee === "no" ? t("feeNo") : charge ? `${t("feeYes")} · ${charge}` : t("feeYes")}
            </Typography>
          </DetailItem>
        )}

        {/* Cuisine */}
        {cuisine && (
          <DetailItem icon={<RestaurantIcon sx={{ fontSize: 20 }} />}>
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {formatList(cuisine)}
            </Typography>
          </DetailItem>
        )}

        {/* Religion + Denomination */}
        {religion && (
          <DetailItem icon={<AccountBalanceIcon sx={{ fontSize: 20 }} />}>
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {denomination
                ? `${capitalize(religion)} · ${capitalize(denomination)}`
                : capitalize(religion)}
            </Typography>
          </DetailItem>
        )}
        {denomination && !religion && (
          <DetailItem icon={<AccountBalanceIcon sx={{ fontSize: 20 }} />}>
            <Typography
              variant="body2"
              sx={{
                color: "text.primary",
              }}
            >
              {capitalize(denomination)}
            </Typography>
          </DetailItem>
        )}

        {/* Compact 2-column grid for boolean/short-value items */}
        {gridItems.length > 0 && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              columnGap: 1,
              py: 0.25,
            }}
          >
            {gridItems}
          </Box>
        )}

        {/* Multilingual text entries (description, note, *:location, etc.) */}
        {multilingualEntries.map((entry) => (
          <Box key={entry.label} sx={{ display: "flex", gap: 1.5, py: 0.75 }}>
            <Box sx={{ color: BRAND, flexShrink: 0, display: "flex", mt: "2px" }}>
              <NotesIcon sx={{ fontSize: 20 }} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontWeight: 600,
                }}
              >
                {entry.label}
              </Typography>
              {entry.defaultValue && (
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.primary",
                    mt: 0.25,
                  }}
                >
                  <Linkified text={entry.defaultValue} color={BRAND} />
                </Typography>
              )}
              {entry.translations.map(({ lang, flag, value }) => (
                <Box key={lang} sx={{ display: "flex", alignItems: "flex-start", gap: 1, mt: 0.5 }}>
                  <Typography
                    component="span"
                    sx={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}
                  >
                    {flag}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <Linkified text={value} color={BRAND} />
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}

        {/* Social media icons row */}
        {socialLinks.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, pt: 0.5, pb: 0.25 }}>
            {socialLinks.map(({ label, icon, url }) => (
              <Tooltip key={label} title={label}>
                <IconButton
                  component="a"
                  href={safeHref(url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  sx={{ color: "text.secondary", "&:hover": { color: BRAND } }}
                >
                  {icon}
                </IconButton>
              </Tooltip>
            ))}
          </Box>
        )}
      </Box>
    </>
  );
}
