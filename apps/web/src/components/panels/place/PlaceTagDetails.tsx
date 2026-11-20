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
import { type Place, safeHref } from "@openmapx/core";
import { contributorsForRecordFields } from "@openmapx/mobility-core/contributors";
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
import { SectionAttribution } from "@/components/ui/SectionAttribution";
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
  keys: string[];
  label: string;
  defaultValue?: string;
  translations: Array<{ lang: string; flag: string; value: string }>;
}

function collectMultilingualEntries(tags: Record<string, string>): MultilingualEntry[] {
  const groups = new Map<
    string,
    { keys: string[]; defaultValue?: string; translations: Map<string, string> }
  >();

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
      group = { keys: [], translations: new Map() };
      groups.set(baseKey, group);
    }
    group.keys.push(key);
    if (lang) group.translations.set(lang, value);
    else group.defaultValue = value;
  }

  const entries: MultilingualEntry[] = [];
  for (const [baseKey, group] of groups) {
    if (!group.defaultValue && group.translations.size === 0) continue;
    const translations = Array.from(group.translations.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([l, v]) => ({ lang: l, flag: langFlag(l), value: v }));
    entries.push({
      keys: group.keys,
      label: formatKey(baseKey),
      defaultValue: group.defaultValue,
      translations,
    });
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
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 0.75 }}>
      {/* As wide as the overview rows' icons, so text lines up in one column. */}
      <Box
        sx={{
          color: BRAND,
          flexShrink: 0,
          display: "flex",
          justifyContent: "center",
          width: 22,
          fontSize: 20,
        }}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

type Translate = (key: string, values?: Record<string, string>) => string;

/** One shown row: its icon, its content and the tags it credits. */
interface TagRow {
  icon: ReactNode;
  content: ReactNode;
  /** The tags the row actually shows, credited to their sources. */
  credits: string[];
}

/**
 * One kind of detail row. `keys` are every tag the row reads, including linked
 * metadata it uses only for a link; all of them stay out of "Other details".
 * Practical rows answer what a visitor needs; the rest describe the place.
 * `list` rows come first, one per line; `grid` rows share a two-column grid.
 */
interface TagSpec {
  id: string;
  keys: readonly string[];
  section: "practical" | "remaining";
  layout: "list" | "grid";
  render: (tags: Record<string, string>, t: Translate, representedEmail?: string) => TagRow | null;
}

const ICON = { fontSize: 20 } as const;

function text(value: ReactNode, color = "text.primary", noWrap = false) {
  return (
    <Typography variant="body2" noWrap={noWrap} sx={{ color }}>
      {value}
    </Typography>
  );
}

function linkedText(url: string | null, label: string) {
  if (!url) return text(label);
  return (
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
  );
}

/** The linked tag a row's link was built from: the Wikipedia article, else the Wikidata item. */
function linkedKeys(tags: Record<string, string>, prefix: string): string[] {
  const wp = tags[`${prefix}:wikipedia`];
  if (wp && wp.indexOf(":") > 0) return [`${prefix}:wikipedia`];
  return tags[`${prefix}:wikidata`] ? [`${prefix}:wikidata`] : [];
}

function humanized(tags: Record<string, string>, key: string): string | undefined {
  return humanizeOsmTagValue(tags[key] ?? "") || tags[key];
}

/** A row with a fixed label for an OSM value, falling back to the capitalized value. */
function labelled(
  key: string,
  labels: Record<string, string>,
  icon: (value: string) => ReactNode,
  muted: (value: string) => boolean = () => false,
): TagSpec["render"] {
  return (tags, t) => {
    const value = tags[key];
    if (!value) return null;
    const labelKey = labels[value];
    return {
      icon: icon(value),
      content: text(
        labelKey ? t(labelKey) : capitalize(value),
        muted(value) ? "text.secondary" : "text.primary",
      ),
      credits: [key],
    };
  };
}

/** A row shown only for `key=yes`, with a fixed label. */
function onlyYes(key: string, labelKey: string, icon: ReactNode): TagSpec["render"] {
  return (tags, t) =>
    tags[key] === "yes" ? { icon, content: text(t(labelKey)), credits: [key] } : null;
}

/** A row showing the tag's value through `format`. */
function valued(
  key: string,
  icon: ReactNode,
  format: (value: string, t: Translate) => ReactNode,
): TagSpec["render"] {
  return (tags, t) => {
    const value = tags[key];
    return value ? { icon, content: text(format(value, t)), credits: [key] } : null;
  };
}

const WHEELCHAIR: Record<string, { color: string; labelKey: string }> = {
  yes: { color: "success.main", labelKey: "wheelchairYes" },
  designated: { color: "success.main", labelKey: "wheelchairDesignated" },
  limited: { color: "warning.main", labelKey: "wheelchairLimited" },
  no: { color: "text.secondary", labelKey: "wheelchairNo" },
};

const OPEN_ACCESS = new Set(["yes", "public", "designated", "permissive", "discouraged"]);
const ACCESS_LABELS: Record<string, string> = {
  yes: "accessPublic",
  public: "accessPublic",
  designated: "accessDesignated",
  permissive: "accessPermissive",
  discouraged: "accessDiscouraged",
  customers: "accessCustomers",
  permit: "accessPermit",
  destination: "accessDestination",
  delivery: "accessDelivery",
  agricultural: "accessAgricultural",
  forestry: "accessForestry",
  military: "accessMilitary",
  private: "accessPrivate",
  no: "accessNo",
};

const TOILETS_WHEELCHAIR: Record<string, string> = {
  yes: "toiletsWheelchairYes",
  designated: "toiletsWheelchairDesignated",
  limited: "toiletsWheelchairLimited",
  no: "toiletsWheelchairNo",
};

/** Every detail row this component knows, in the order they are shown. */
const TAG_SPECS: readonly TagSpec[] = [
  {
    id: "operator",
    keys: ["operator", "operator:wikidata", "operator:wikipedia"],
    section: "remaining",
    layout: "list",
    render: (tags) => {
      const operator = humanized(tags, "operator");
      if (!operator) return null;
      return {
        icon: <BusinessIcon sx={ICON} />,
        content: linkedText(resolveLinkedUrl(tags, "operator"), operator),
        credits: ["operator", ...linkedKeys(tags, "operator")],
      };
    },
  },
  {
    id: "brand",
    keys: ["brand", "network", "brand:wikidata", "brand:wikipedia"],
    section: "remaining",
    layout: "list",
    render: (tags) => {
      const brand = humanized(tags, "brand");
      const network = humanized(tags, "network");
      // A brand that only repeats the operator adds nothing.
      if ((!brand && !network) || (brand && brand === humanized(tags, "operator"))) return null;
      const label =
        brand && network && brand !== network ? `${brand} (${network})` : (brand ?? network ?? "");
      return {
        icon: <StorefrontIcon sx={ICON} />,
        content: linkedText(resolveLinkedUrl(tags, "brand"), label),
        credits: [
          ...(brand ? ["brand"] : []),
          ...(network && (!brand || network !== brand) ? ["network"] : []),
          ...linkedKeys(tags, "brand"),
        ],
      };
    },
  },
  {
    id: "email",
    keys: ["email", "contact:email"],
    section: "practical",
    layout: "list",
    render: (tags, _t, representedEmail) => {
      const email = tags.email ?? tags["contact:email"];
      // The card's own contact row may already show this address.
      if (!email || email.trim().toLowerCase() === representedEmail?.trim().toLowerCase()) {
        return null;
      }
      return {
        icon: <EmailIcon sx={ICON} />,
        content: (
          <Link
            href={`mailto:${email}`}
            variant="body2"
            underline="hover"
            sx={{ color: "text.primary" }}
          >
            {email}
          </Link>
        ),
        credits: [tags.email !== undefined ? "email" : "contact:email"],
      };
    },
  },
  {
    id: "wheelchair",
    keys: ["wheelchair"],
    section: "practical",
    layout: "list",
    render: (tags, t) => {
      const value = tags.wheelchair;
      if (!value) return null;
      const known = WHEELCHAIR[value];
      return {
        icon: <AccessibleIcon sx={{ ...ICON, color: known?.color ?? "text.secondary" }} />,
        content: text(
          known ? t(known.labelKey) : capitalize(value),
          known?.color ?? "text.primary",
        ),
        credits: ["wheelchair"],
      };
    },
  },
  {
    id: "access",
    keys: ["access"],
    section: "practical",
    layout: "list",
    render: labelled("access", ACCESS_LABELS, (value) =>
      !ACCESS_LABELS[value] || OPEN_ACCESS.has(value) ? (
        <LockOpenIcon sx={ICON} />
      ) : (
        <LockIcon sx={{ ...ICON, color: "text.secondary" }} />
      ),
    ),
  },
  {
    id: "fee",
    keys: ["fee", "charge"],
    section: "practical",
    layout: "list",
    render: (tags, t) => {
      const { fee, charge } = tags;
      if (!fee && !charge) return null;
      return {
        icon: fee === "no" ? <MoneyOffIcon sx={ICON} /> : <AttachMoneyIcon sx={ICON} />,
        content: text(
          fee === "no" ? t("feeNo") : charge ? `${t("feeYes")} · ${charge}` : t("feeYes"),
        ),
        credits: [...(fee ? ["fee"] : []), ...(charge && fee !== "no" ? ["charge"] : [])],
      };
    },
  },
  {
    id: "cuisine",
    keys: ["cuisine"],
    section: "practical",
    layout: "list",
    render: valued("cuisine", <RestaurantIcon sx={ICON} />, formatList),
  },
  {
    id: "religion",
    keys: ["religion", "denomination"],
    section: "remaining",
    layout: "list",
    render: (tags) => {
      const { religion, denomination } = tags;
      if (!religion && !denomination) return null;
      return {
        icon: <AccountBalanceIcon sx={ICON} />,
        content: text(
          [religion, denomination]
            .filter((value): value is string => Boolean(value))
            .map(capitalize)
            .join(" · "),
        ),
        credits: [...(religion ? ["religion"] : []), ...(denomination ? ["denomination"] : [])],
      };
    },
  },
  {
    id: "indoor",
    keys: ["indoor"],
    section: "remaining",
    layout: "grid",
    render: valued("indoor", <MeetingRoomIcon sx={ICON} />, (value, t) =>
      value === "yes" ? t("indoor") : t("outdoor"),
    ),
  },
  {
    id: "level",
    keys: ["level"],
    section: "remaining",
    layout: "grid",
    render: valued("level", <StairsIcon sx={ICON} />, (value, t) => `${t("level")} ${value}`),
  },
  {
    id: "locked",
    keys: ["locked"],
    section: "remaining",
    layout: "grid",
    render: (tags, t) =>
      tags.locked
        ? {
            icon: tags.locked === "yes" ? <LockIcon sx={ICON} /> : <LockOpenIcon sx={ICON} />,
            content: text(tags.locked === "yes" ? t("locked") : t("unlocked")),
            credits: ["locked"],
          }
        : null,
  },
  {
    id: "capacity",
    keys: ["capacity"],
    section: "remaining",
    layout: "grid",
    render: valued("capacity", <GroupIcon sx={ICON} />, (value, t) => `${t("capacity")} ${value}`),
  },
  {
    id: "stars",
    keys: ["stars"],
    section: "remaining",
    layout: "grid",
    render: valued("stars", <StarIcon sx={ICON} />, (value) => {
      const n = parseInt(value, 10);
      return !Number.isNaN(n) && n <= 7 ? "★".repeat(n) : `${value} ★`;
    }),
  },
  {
    id: "ele",
    keys: ["ele"],
    section: "remaining",
    layout: "grid",
    render: valued("ele", <LandscapeIcon sx={ICON} />, (value) => `${value} m`),
  },
  {
    id: "surface",
    keys: ["surface"],
    section: "remaining",
    layout: "grid",
    render: valued("surface", <TerrainIcon sx={ICON} />, (value) =>
      capitalize(value.replace(/_/g, " ")),
    ),
  },
  {
    id: "height",
    keys: ["height"],
    section: "remaining",
    layout: "grid",
    render: valued("height", <HeightIcon sx={ICON} />, (value) => `${value} m`),
  },
  {
    id: "building:levels",
    keys: ["building:levels"],
    section: "remaining",
    layout: "grid",
    render: valued(
      "building:levels",
      <ApartmentIcon sx={ICON} />,
      (value, t) => `${value} ${t("floors")}`,
    ),
  },
  {
    id: "smoking",
    keys: ["smoking"],
    section: "practical",
    layout: "grid",
    render: labelled(
      "smoking",
      {
        yes: "smokingYes",
        no: "smokingNo",
        outside: "smokingOutside",
        separated: "smokingSeparated",
        isolated: "smokingIsolated",
      },
      (value) => (value === "no" ? <SmokeFreeIcon sx={ICON} /> : <SmokingRoomsIcon sx={ICON} />),
      (value) => value === "no",
    ),
  },
  {
    id: "dog",
    keys: ["dog"],
    section: "practical",
    layout: "grid",
    render: labelled(
      "dog",
      { yes: "dogYes", no: "dogNo", leashed: "dogLeashed" },
      (value) => (
        <PetsIcon sx={{ ...ICON, color: value === "no" ? "text.secondary" : undefined }} />
      ),
      (value) => value === "no",
    ),
  },
  {
    id: "drive_through",
    keys: ["drive_through"],
    section: "practical",
    layout: "grid",
    render: onlyYes("drive_through", "driveThrough", <DriveEtaIcon sx={ICON} />),
  },
  {
    id: "delivery",
    keys: ["delivery"],
    section: "practical",
    layout: "grid",
    render: onlyYes("delivery", "delivery", <LocalShippingIcon sx={ICON} />),
  },
  {
    id: "takeaway",
    keys: ["takeaway"],
    section: "practical",
    layout: "grid",
    render: (tags, t) => {
      const labelKey = { yes: "takeawayYes", only: "takeawayOnly" }[tags.takeaway ?? ""];
      return labelKey
        ? {
            icon: <TakeoutDiningIcon sx={ICON} />,
            content: text(t(labelKey)),
            credits: ["takeaway"],
          }
        : null;
    },
  },
  {
    id: "outdoor_seating",
    keys: ["outdoor_seating"],
    section: "practical",
    layout: "grid",
    render: onlyYes("outdoor_seating", "outdoorSeating", <DeckIcon sx={ICON} />),
  },
  {
    id: "internet_access",
    keys: ["internet_access"],
    section: "practical",
    layout: "grid",
    render: (tags, t) => {
      const value = tags.internet_access;
      if (!value) return null;
      const isNo = value === "no";
      return {
        icon: isNo ? (
          <WifiOffIcon sx={{ ...ICON, color: "text.secondary" }} />
        ) : (
          <WifiIcon sx={ICON} />
        ),
        content: text(
          isNo ? t("noWifi") : t("wifiAvailable"),
          isNo ? "text.secondary" : "text.primary",
        ),
        credits: ["internet_access"],
      };
    },
  },
  {
    id: "drinking_water",
    keys: ["drinking_water"],
    section: "practical",
    layout: "grid",
    render: onlyYes("drinking_water", "drinkingWater", <WaterDropIcon sx={ICON} />),
  },
  {
    id: "toilets",
    keys: ["toilets", "toilets:wheelchair"],
    section: "practical",
    layout: "grid",
    render: (tags, t) => {
      const wheelchair = tags["toilets:wheelchair"];
      if (tags.toilets !== "yes" && !wheelchair) return null;
      const wheelchairKey = wheelchair ? TOILETS_WHEELCHAIR[wheelchair] : null;
      return {
        icon: <WcIcon sx={ICON} />,
        content: text(
          <>
            {t("toilets")}
            {wheelchairKey && (
              <Typography
                component="span"
                variant="body2"
                sx={{
                  color:
                    wheelchair === "no"
                      ? "text.secondary"
                      : wheelchair === "limited"
                        ? "warning.main"
                        : "success.main",
                }}
              >
                {" · "}
                {t(wheelchairKey)}
              </Typography>
            )}
          </>,
        ),
        credits: [
          ...(tags.toilets === "yes" ? ["toilets"] : []),
          ...(wheelchair ? ["toilets:wheelchair"] : []),
        ],
      };
    },
  },
  {
    id: "changing_table",
    keys: ["changing_table"],
    section: "practical",
    layout: "grid",
    render: onlyYes("changing_table", "changingTable", <BabyChangingStationIcon sx={ICON} />),
  },
  {
    id: "shower",
    keys: ["shower"],
    section: "remaining",
    layout: "grid",
    render: onlyYes("shower", "shower", <WaterDropIcon sx={ICON} />),
  },
  {
    id: "start_date",
    keys: ["start_date"],
    section: "remaining",
    layout: "grid",
    render: valued("start_date", <EventIcon sx={ICON} />, (value) => value),
  },
  {
    id: "heritage",
    keys: ["heritage"],
    section: "remaining",
    layout: "grid",
    render: valued("heritage", <AccountBalanceIcon sx={ICON} />, (value, t) =>
      t(
        { "1": "heritageWorld", "2": "heritageNational", "3": "heritageRegional" }[value] ??
          "heritageYes",
      ),
    ),
  },
  {
    id: "min_age",
    keys: ["min_age"],
    section: "remaining",
    layout: "grid",
    render: valued("min_age", <GroupIcon sx={ICON} />, (value, t) => t("minAge", { age: value })),
  },
  {
    id: "manufacturer",
    keys: ["manufacturer", "model"],
    section: "remaining",
    layout: "grid",
    render: (tags) => {
      const { manufacturer, model } = tags;
      if (!manufacturer && !model) return null;
      return {
        icon: <PrecisionManufacturingIcon sx={ICON} />,
        content: text([manufacturer, model].filter(Boolean).join(" · "), "text.primary", true),
        credits: [...(manufacturer ? ["manufacturer"] : []), ...(model ? ["model"] : [])],
      };
    },
  },
];

/**
 * Tags other parts of the place card show (the overview's contact rows, the
 * reviews tab and the photo gallery), kept out of "Other details" too.
 */
const SHOWN_ELSEWHERE_KEYS = [
  "contact:phone",
  "contact:website",
  "contact:tripadvisor",
  "contact:yelp",
  "ref:yelp",
  "image",
];

const CONSUMED_SIMPLE_KEYS = new Set([
  ...TAG_SPECS.flatMap((spec) => spec.keys),
  ...SOCIAL_PLATFORMS.map((platform) => platform.tagKey),
  ...SHOWN_ELSEWHERE_KEYS,
]);

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
  section?: "all" | "practical" | "remaining";
  /** Off when the details continue a section that already opened with a divider. */
  divider?: boolean;
  representedEmail?: string;
  place?: Pick<Place, "contributors" | "fieldContributors">;
}

export function PlaceTagDetails({
  osmTags,
  section = "all",
  divider = true,
  representedEmail,
  place,
}: Props) {
  const t = useTranslations("place");
  const shows = (rowSection: TagSpec["section"]) => section === "all" || section === rowSection;

  const rows = TAG_SPECS.filter((spec) => shows(spec.section)).flatMap((spec) => {
    const row = spec.render(osmTags, t, representedEmail);
    return row ? [{ ...row, id: spec.id, layout: spec.layout }] : [];
  });
  const multilingualEntries = shows("remaining") ? collectMultilingualEntries(osmTags) : [];
  const socialLinks = shows("practical")
    ? SOCIAL_PLATFORMS.filter((p) => osmTags[p.tagKey]).map((p) => ({
        tagKey: p.tagKey,
        label: p.label,
        icon: p.icon,
        url: p.toUrl(osmTags[p.tagKey]),
      }))
    : [];
  if (rows.length === 0 && multilingualEntries.length === 0 && socialLinks.length === 0) {
    return null;
  }

  const listRows = rows.filter((row) => row.layout === "list");
  const gridRows = rows.filter((row) => row.layout === "grid");
  const displayedKeys = [
    ...rows.flatMap((row) => row.credits),
    ...multilingualEntries.flatMap((entry) => entry.keys),
    ...socialLinks.map((link) => link.tagKey),
  ];
  const attributions = place
    ? contributorsForRecordFields(
        place,
        displayedKeys.map((key) => `osmTags.${key}`),
      )
    : [];

  return (
    <>
      {divider && <Divider sx={{ mx: section === "practical" ? 0 : 2, my: 1 }} />}
      <Box sx={{ px: section === "practical" ? 0 : 2, py: 0.5 }}>
        {listRows.map((row) => (
          <DetailItem key={row.id} icon={row.icon}>
            {row.content}
          </DetailItem>
        ))}

        {/* Compact 2-column grid for boolean/short-value items */}
        {gridRows.length > 0 && (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              columnGap: 1,
              py: 0.25,
            }}
          >
            {gridRows.map((row) => (
              <DetailItem key={row.id} icon={row.icon}>
                {row.content}
              </DetailItem>
            ))}
          </Box>
        )}

        {/* Multilingual text entries (description, note, *:location, etc.) */}
        {multilingualEntries.map((entry) => (
          <Box key={entry.label} sx={{ display: "flex", gap: 2, py: 0.75 }}>
            <Box
              sx={{
                color: BRAND,
                flexShrink: 0,
                display: "flex",
                justifyContent: "center",
                width: 22,
                mt: "2px",
              }}
            >
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
      <SectionAttribution attributions={attributions} inset={section !== "practical"} />
    </>
  );
}
