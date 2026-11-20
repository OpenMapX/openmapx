"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { useLocale, useTranslations } from "next-intl";
import type { AdminTranslator } from "@/lib/admin/adminTranslator";

type OsmExtract = NonNullable<AdminServiceData["osmExtract"]>;

/** Past this age the card flags the extract: Geofabrik publishes a new one every day. */
export const STALE_EXTRACT_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long ago the extract's data was current, coarsely: hours within two days, else days. */
export function extractAge(
  timestamp: string,
  now: number,
  locale: string,
  t: AdminTranslator,
): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsed < HOUR_MS) return t("extractAgeUnderAnHour");
  if (elapsed < 2 * DAY_MS) return format.format(-Math.floor(elapsed / HOUR_MS), "hour");
  return format.format(-Math.floor(elapsed / DAY_MS), "day");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * When the OSM extract's data is current to, from the file's own header, and
 * the diff feed that continues it. Download time says nothing about this: a
 * mirror can serve a weeks-old file today.
 */
export function OsmExtractDetails({
  extract,
  now = Date.now(),
}: {
  extract: OsmExtract | undefined;
  now?: number;
}) {
  const t = useTranslations("adminServices");
  const locale = useLocale();
  if (!extract) {
    return (
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("dataAsOf")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("unknownTheFileRecordsNo")}
        </Typography>
      </Box>
    );
  }
  const stale = now - Date.parse(extract.timestamp) > STALE_EXTRACT_DAYS * DAY_MS;
  return (
    <>
      <Box>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("dataAsOf")}
        </Typography>
        <Typography variant="body2">
          {formatDate(extract.timestamp)} ({extractAge(extract.timestamp, now, locale, t)})
        </Typography>
        {stale && (
          <Chip
            label={t("olderThanStaleExtractDays", { STALE_EXTRACT_DAYS })}
            color="warning"
            size="small"
            sx={{ mt: 0.5 }}
          />
        )}
      </Box>
      {extract.replicationUrl && (
        <Box>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("updateFeedForNominatimReplication")}
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
            {extract.replicationUrl}
          </Typography>
        </Box>
      )}
    </>
  );
}
