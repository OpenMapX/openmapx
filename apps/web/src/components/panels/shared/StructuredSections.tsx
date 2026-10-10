"use client";

import BoltIcon from "@mui/icons-material/Bolt";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoIcon from "@mui/icons-material/Info";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import PaymentsIcon from "@mui/icons-material/Payments";
import VideocamIcon from "@mui/icons-material/Videocam";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { type PricingPlanEntry, proxyImageUrl, safeHref } from "@openmapx/core";
import { formatMoney } from "@openmapx/integration-framework/strings";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { HlsVideo } from "@/components/ui/HlsVideo";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

export interface StructuredSection {
  id?: string;
  title: string;
  /** Optional subtitle rendered beneath the section header (e.g. live availability). */
  caption?: string;
  /** ISO timestamp the caption was last refreshed; renders a "· N ago" suffix. */
  captionTimestamp?: string;
  type: "table" | "list" | "text" | "image" | "embed" | "pricing";
  columns?: string[];
  rows?: (string | number)[][];
  /** Layout for ≥3-cell rows — see `DataSourceDetailSection.rowLayout`. */
  rowLayout?: "connector" | "pricing";
  items?: string[];
  content?: string;
  imageUrl?: string;
  imageAlt?: string;
  linkUrl?: string;
  /** Seconds between new stills; an image section re-requests its still at that pace while on screen. */
  refreshSec?: number;
  embedUrl?: string;
  embedType?: "iframe" | "video";
  sectionIcon?: ReactNode | string;
  pricingPlans?: PricingPlanEntry[];
  /** Optional clickable links rendered beneath the section body (e.g. a tariff
   *  terms link). An entry with no `url` renders as plain descriptive text. */
  links?: { label: string; url?: string }[];
  collapsed?: boolean;
}

interface StructuredSectionsProps {
  sections: StructuredSection[];
  pricingLabels?: {
    standard: string;
    unlockFee: string;
    perKm: string;
    perHour: string;
    free: string;
  };
}

function isUrl(str: string): boolean {
  return /^https?:\/\//.test(str) || /^[a-z][\w-]*:\/\//.test(str);
}

function renderSectionIcon(sectionIcon?: ReactNode | string): ReactNode {
  if (typeof sectionIcon !== "string") return sectionIcon ?? <BoltIcon />;
  switch (sectionIcon) {
    case "fuel":
      return <LocalGasStationIcon />;
    case "access_time":
      return <InfoIcon />;
    case "info":
      return <InfoIcon />;
    case "directions_bus":
      return <DirectionsBusIcon />;
    case "directions_car":
      return <DirectionsCarIcon />;
    case "payments":
      return <PaymentsIcon />;
    case "open_in_new":
      return <InfoIcon />;
    case "videocam":
      return <VideocamIcon sx={{ fontSize: 18 }} />;
    case "warning":
      return <WarningAmberIcon sx={{ fontSize: 18 }} />;
    default:
      return <BoltIcon />;
  }
}

/** The colour of a connector row's status, by the status kind its last cell names. */
const STATUS_KIND_COLOR: Readonly<Record<string, string>> = {
  available: "success.main",
  busy: "warning.main",
  out: "error.main",
};

function ConnectorRow({ row }: { row: (string | number)[] }) {
  const [type, power, current, qty, status, kind] = row;
  const statusStr = String(status ?? "");

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 0.75,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap>
          {type}
        </Typography>
        <Typography
          variant="caption"
          noWrap
          sx={{
            color: "text.secondary",
          }}
        >
          {power}
          {current ? ` · ${current}` : ""}
          {qty && Number(qty) > 1 ? ` · ${qty}x` : ""}
        </Typography>
      </Box>
      <Typography
        variant="caption"
        sx={{
          color: STATUS_KIND_COLOR[String(kind ?? "")] ?? "text.disabled",
          fontWeight: 500,
          flexShrink: 0,
          ml: 1,
        }}
      >
        {statusStr}
      </Typography>
    </Box>
  );
}

const EURO_PRICE_RE = /^(\d+\.\d{2})(\d)\s*€$/;

function FormattedValue({ value }: { value: string | number }) {
  const str = String(value);
  const match = str.match(EURO_PRICE_RE);
  if (match) {
    return (
      <span style={{ display: "inline-flex", alignItems: "flex-start" }}>
        <span>{match[1]}</span>
        <span style={{ fontSize: "0.65em", marginTop: "0.15em" }}>{match[2]}</span>
        <span>&nbsp;€</span>
      </span>
    );
  }
  return <>{value}</>;
}

/**
 * `[label, price, conditions]` — the label (a tariff dimension, or the
 * connectors the price applies to) with its conditions as a caption beneath,
 * and the price on the right. A blank label continues the row above it, which
 * is how a tariff with several price components reads as one block.
 */
function PricingRow({ row }: { row: (string | number)[] }) {
  const [label, price, conditions] = row;
  const conditionsStr = String(conditions ?? "");

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 1,
        py: 0.5,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {label}
        </Typography>
        {conditionsStr && (
          <Typography variant="caption" sx={{ color: "text.disabled", display: "block" }}>
            {conditionsStr}
          </Typography>
        )}
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 500, flexShrink: 0, textAlign: "right" }}>
        <FormattedValue value={price} />
      </Typography>
    </Box>
  );
}

function KeyValueRow({ row }: { row: (string | number)[] }) {
  const [label, value] = row;
  const valueStr = String(value);
  const isLink = typeof value === "string" && isUrl(value);
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 0.5,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      {isLink ? (
        <Link
          href={safeHref(valueStr)}
          target="_blank"
          rel="noopener noreferrer"
          underline="hover"
          variant="body2"
          sx={{
            ml: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {valueStr.replace(/^https?:\/\//, "").split("?")[0]}
        </Link>
      ) : (
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            ml: 1,
            minWidth: 0,
            textAlign: "right",
          }}
        >
          <FormattedValue value={value} />
        </Typography>
      )}
    </Box>
  );
}

function PricingPlanRow({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "space-between",
        py: 0.5,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function PricingPlansSection({
  plans,
  labels,
}: {
  plans: PricingPlanEntry[];
  labels?: StructuredSectionsProps["pricingLabels"];
}) {
  const resolvedLabels = {
    standard: labels?.standard ?? "Standard",
    unlockFee: labels?.unlockFee ?? "Unlock fee",
    perKm: labels?.perKm ?? "Per km",
    perHour: labels?.perHour ?? "Per hour",
    free: labels?.free ?? "Free",
  };
  const locale = useLocale();
  return (
    <Box>
      {plans.map((plan, i) => {
        // The reader's locale places the symbol and the decimal separator.
        const price = (amount: number) => formatMoney(amount, plan.currency, locale);
        const name = plan.name || resolvedLabels.standard;
        const showName = plans.length > 1 || !!plan.name;
        const planKey = `${plan.name}-${plan.currency}-${plan.unlockFee ?? ""}-${plan.perKm ?? ""}-${plan.perHour ?? ""}`;
        return (
          <Box key={planKey}>
            {i > 0 && <Divider sx={{ my: 1 }} />}
            {showName && (
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  mb: 0.5,
                }}
              >
                {name}
              </Typography>
            )}
            {plan.free ? (
              <PricingPlanRow label={resolvedLabels.unlockFee} value={resolvedLabels.free} />
            ) : (
              <>
                {plan.unlockFee !== undefined && (
                  <PricingPlanRow label={resolvedLabels.unlockFee} value={price(plan.unlockFee)} />
                )}
                {plan.perKm !== undefined && (
                  <PricingPlanRow label={resolvedLabels.perKm} value={`${price(plan.perKm)}/km`} />
                )}
                {plan.perHour !== undefined && (
                  <PricingPlanRow
                    label={resolvedLabels.perHour}
                    value={`${price(plan.perHour)}/h`}
                  />
                )}
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The shortest pause between two requests of one still, whatever the source says. */
const MIN_REFRESH_SEC = 30;

function pageShown(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * When the still should be re-requested: a new stamp every `refreshSec`
 * seconds (at least 30), counted only while the element is on screen and the
 * page is shown. A hidden section or tab asks for nothing. The element is
 * taken through the returned callback ref, so a frame that mounts after the
 * first render (a new still after a failed one) is observed too.
 */
function useRefreshStamp(
  refreshSec: number | undefined,
): [
  (element: HTMLElement | null) => void,
  number | undefined,
  (stamp: number | undefined) => void,
] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [stamp, setStamp] = useState<number | undefined>(undefined);
  const [onScreen, setOnScreen] = useState(false);
  const [shown, setShown] = useState(pageShown);
  const refreshing = refreshSec !== undefined && refreshSec > 0;

  useEffect(() => {
    if (!refreshing || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      // A frame that is gone is not on screen; the next one reports for itself.
      setOnScreen(false);
    };
  }, [element, refreshing]);

  useEffect(() => {
    if (!refreshing) return;
    const onChange = () => setShown(pageShown());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [refreshing]);

  useEffect(() => {
    if (!refreshing || !onScreen || !shown) return;
    const every = Math.max(refreshSec, MIN_REFRESH_SEC) * 1000;
    const timer = setInterval(() => setStamp(Date.now()), every);
    return () => clearInterval(timer);
  }, [refreshing, refreshSec, onScreen, shown]);

  return [setElement, stamp, setStamp];
}

function ImageSection({ section }: { section: StructuredSection }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [frame, stamp, setStamp] = useRefreshStamp(section.refreshSec);
  // The stamp of the last still that loaded, so a failed refresh falls back to it.
  const loadedStamp = useRef<number | undefined>(undefined);
  if (!section.imageUrl || failedImageUrl === section.imageUrl) return null;

  const proxied = proxyImageUrl(section.imageUrl);
  // A changed query parameter makes the browser ask the proxy again; the proxy ignores it.
  const src =
    stamp === undefined ? proxied : `${proxied}${proxied.includes("?") ? "&" : "?"}t=${stamp}`;
  const image = (
    <Box
      component="img"
      src={src}
      alt={section.imageAlt ?? section.title}
      onLoad={() => {
        loadedStamp.current = stamp;
      }}
      onError={() => {
        if (stamp !== undefined && stamp !== loadedStamp.current) setStamp(loadedStamp.current);
        else setFailedImageUrl(section.imageUrl ?? null);
      }}
      sx={{ width: "100%", borderRadius: 2, display: "block" }}
    />
  );
  return (
    <Box ref={frame} sx={{ mb: 1 }}>
      {section.linkUrl ? (
        <Link
          href={safeHref(section.linkUrl)}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ display: "block" }}
        >
          {image}
        </Link>
      ) : (
        image
      )}
    </Box>
  );
}

function isExternalBrowserUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (typeof window === "undefined") return true;
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function ExternalMediaEmbed({ section }: { section: StructuredSection }) {
  const t = useTranslations("dataSources");
  const [acceptedEmbedUrl, setAcceptedEmbedUrl] = useState<string | null>(null);

  if (!section.embedUrl) return null;
  const embeddable = isExternalBrowserUrl(section.embedUrl);
  if (!embeddable) return null;

  const loaded = embeddable && acceptedEmbedUrl === section.embedUrl;

  if (!loaded) {
    return (
      <Box
        sx={{
          mb: 1,
          minHeight: 156,
          aspectRatio: "16/9",
          border: 1,
          borderColor: "divider",
          borderRadius: 2,
          bgcolor: "action.hover",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          px: 2,
        }}
      >
        <Box sx={{ maxWidth: 300 }}>
          <VideocamIcon sx={{ fontSize: 24, color: "text.secondary", mb: 0.5 }} />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
            }}
          >
            {t("externalMediaTitle")}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
              mt: 0.5,
            }}
          >
            {t("externalMediaBody")}
          </Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={() => setAcceptedEmbedUrl(section.embedUrl ?? null)}
            sx={{ mt: 1.25, textTransform: "none", fontWeight: 600 }}
          >
            {t("loadExternalMedia")}
          </Button>
        </Box>
      </Box>
    );
  }

  if (section.embedType === "video") {
    return (
      <Box sx={{ mb: 1 }}>
        <HlsVideo
          src={section.embedUrl}
          controls
          autoPlay
          muted
          style={{ width: "100%", borderRadius: 8, display: "block" }}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 1 }}>
      <Box
        component="iframe"
        src={section.embedUrl}
        // This pair is safe here because the guard only permits cross-origin embeds.
        sandbox="allow-scripts allow-same-origin"
        sx={{
          width: "100%",
          aspectRatio: "16/9",
          border: "none",
          borderRadius: 2,
          display: "block",
        }}
      />
    </Box>
  );
}

function SectionContent({
  section,
  pricingLabels,
}: {
  section: StructuredSection;
  pricingLabels?: StructuredSectionsProps["pricingLabels"];
}) {
  switch (section.type) {
    case "table": {
      if (!section.rows || section.rows.length === 0) return null;
      const isKeyValue = section.rows.every((row) => row.length === 2);
      if (isKeyValue) {
        return (
          <Box>
            {section.rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static render rows have no stable id
              <KeyValueRow key={index} row={row} />
            ))}
          </Box>
        );
      }
      const Row = section.rowLayout === "pricing" ? PricingRow : ConnectorRow;
      return (
        <Box>
          {section.rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static render rows have no stable id
            <Row key={index} row={row} />
          ))}
        </Box>
      );
    }

    case "pricing":
      return section.pricingPlans?.length ? (
        <PricingPlansSection plans={section.pricingPlans} labels={pricingLabels} />
      ) : null;

    case "list":
      return section.items?.length ? (
        <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
          {section.items.map((item) => (
            <Box component="li" key={item} sx={{ fontSize: 13, mb: 0.25 }}>
              {item}
            </Box>
          ))}
        </Box>
      ) : null;

    case "text":
      return section.content ? (
        <Typography variant="body2" sx={{ mb: 1 }}>
          {section.content}
        </Typography>
      ) : null;

    case "image": {
      return <ImageSection section={section} />;
    }

    case "embed":
      return <ExternalMediaEmbed section={section} />;

    default:
      return null;
  }
}

function SectionLinks({ links }: { links?: StructuredSection["links"] }) {
  if (!links || links.length === 0) return null;
  return (
    <Box sx={{ mt: 0.75 }}>
      {links.map((link) =>
        link.url ? (
          <Link
            key={`${link.label}|${link.url}`}
            href={safeHref(link.url)}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            variant="body2"
            sx={{ display: "block" }}
          >
            {link.label}
          </Link>
        ) : (
          <Typography key={`${link.label}|`} variant="body2" sx={{ color: "text.secondary" }}>
            {link.label}
          </Typography>
        ),
      )}
    </Box>
  );
}

function StructuredSectionCard({
  section,
  pricingLabels,
}: {
  section: StructuredSection;
  pricingLabels?: StructuredSectionsProps["pricingLabels"];
}) {
  const collapsed = section.collapsed ?? section.type === "embed";
  const [expanded, setExpanded] = useState(!collapsed);
  const deferCollapsedContent = collapsed && section.type === "embed";
  const { relative } = useDateTimeFormat();
  const relativeCaption =
    section.caption && section.captionTimestamp ? relative(section.captionTimestamp) : undefined;

  return (
    <Box sx={{ px: 2, py: 1.25 }}>
      {/* Header row — icon, title and chevron share one center-aligned row so
          the title sits vertically in line with the icon. */}
      <Box
        sx={{
          display: "flex",
          gap: 2,
          alignItems: "center",
          justifyContent: "space-between",
          ...(collapsed ? { cursor: "pointer" } : {}),
        }}
        onClick={collapsed ? () => setExpanded((value) => !value) : undefined}
      >
        <Box sx={{ display: "flex", gap: 2, alignItems: "center", minWidth: 0, flex: 1 }}>
          <Box
            sx={{
              color: BRAND,
              flexShrink: 0,
              display: "flex",
              justifyContent: "center",
              width: 24,
            }}
          >
            {renderSectionIcon(section.sectionIcon)}
          </Box>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 0 }}>
            {section.title}
          </Typography>
        </Box>
        {collapsed && (
          <IconButton size="small" sx={{ ml: 0.5, p: 0, flexShrink: 0 }}>
            <ExpandMoreIcon
              sx={{
                fontSize: 18,
                transform: expanded ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
              }}
            />
          </IconButton>
        )}
      </Box>
      {section.caption && (
        <Typography
          variant="caption"
          sx={{
            display: "block",
            color: "text.secondary",
            pl: 5,
            mt: 0.25,
          }}
        >
          {section.caption}
          {relativeCaption && ` · ${relativeCaption}`}
        </Typography>
      )}
      {/* Body — indented to align under the title (icon width 24 + gap 16). */}
      <Box sx={{ pl: 5, mt: expanded ? 0.5 : 0, minWidth: 0 }}>
        {collapsed ? (
          <Collapse
            in={expanded}
            mountOnEnter={deferCollapsedContent}
            unmountOnExit={deferCollapsedContent}
          >
            <SectionContent section={section} pricingLabels={pricingLabels} />
            <SectionLinks links={section.links} />
          </Collapse>
        ) : (
          <>
            <SectionContent section={section} pricingLabels={pricingLabels} />
            <SectionLinks links={section.links} />
          </>
        )}
      </Box>
    </Box>
  );
}

export function StructuredSections({ sections, pricingLabels }: StructuredSectionsProps) {
  return (
    <>
      {sections.map((section) => (
        <StructuredSectionCard
          key={section.id ?? section.title}
          section={section}
          pricingLabels={pricingLabels}
        />
      ))}
    </>
  );
}
