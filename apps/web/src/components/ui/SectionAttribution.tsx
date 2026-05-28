"use client";

import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface SectionAttributionProps {
  /** Source name (e.g. "Cambio CarSharing"). */
  name: string;
  /** Optional canonical URL the name links to. */
  url?: string;
  /** Optional license string (e.g. "Datenlizenz Deutschland Zero 2.0"). */
  license?: string;
  /** Optional URL the license string links to. */
  licenseUrl?: string;
}

function maybeLink(label: string, href: string | undefined): ReactNode {
  if (!href) return label;
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover" color="inherit">
      {label}
    </Link>
  );
}

/**
 * Standardised one-line attribution for place-panel sections. Matches the
 * bottom-of-panel `AttributionFooter` in `DataSourceSections` so every
 * per-section attribution looks identical — same `Data: © Name (License)`
 * shape, font size, and link styling.
 */
export function SectionAttribution({ name, url, license, licenseUrl }: SectionAttributionProps) {
  const tc = useTranslations("common");
  if (!name) return null;
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{
        color: "text.secondary",
        mt: 0.5,
        display: "block",
      }}
    >
      {tc("data")}: © {maybeLink(name, url)}
      {license && <> ({maybeLink(license, licenseUrl)})</>}
    </Typography>
  );
}
