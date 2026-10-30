"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  type BrandLogoAttribution,
  type DataSourceBranding,
  isDisplayablePhoto,
  proxyImageUrl,
  useBrandLogoAttribution,
} from "@openmapx/core";
import { contributorsForRecordFields } from "@openmapx/mobility-core/contributors";
import { type ReactNode, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { PhotoAttribution } from "../place/PhotoAttribution";

interface Props {
  branding?: DataSourceBranding;
  fallbackName?: string;
  size?: number;
  /** Row content belongs beside the mark; credits span the complete row below. */
  children?: ReactNode;
  fallbackMark?: ReactNode;
  /** Interactive owners keep credit links/actions outside their row button. */
  renderRow?: (parts: { content: ReactNode; credits: ReactNode }) => ReactNode;
}

function fallbackInitial(branding?: DataSourceBranding, fallbackName?: string): string {
  const value = branding?.name ?? branding?.legalName ?? fallbackName ?? "?";
  return value.trim().charAt(0).toUpperCase() || "?";
}

/** Only catalogue-backed marks acquire file metadata; feed/synthetic marks need no query. */
export function BrandMark(props: Props) {
  const logo = props.branding?.catalogueLogo;
  return logo && !props.branding?.logoUrl && !props.branding?.imageUrl ? (
    <CatalogueBrandMark {...props} logo={logo} />
  ) : (
    <ResolvedBrandMark {...props} />
  );
}

function CatalogueBrandMark({
  logo,
  ...props
}: Props & { logo: NonNullable<DataSourceBranding["catalogueLogo"]> }) {
  const { data: photo } = useBrandLogoAttribution(logo.qid, logo.file);
  return <ResolvedBrandMark {...props} photo={photo} />;
}

function ResolvedBrandMark({
  branding,
  fallbackName,
  size = 28,
  children,
  fallbackMark,
  renderRow,
  photo,
}: Props & { photo?: BrandLogoAttribution }) {
  const rawImageUrl = photo?.thumbnailUrl ?? photo?.url ?? branding?.logoUrl ?? branding?.imageUrl;
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageUrl =
    rawImageUrl &&
    failedImageUrl !== rawImageUrl &&
    isDisplayablePhoto(photo ?? { url: rawImageUrl, source: "branding" })
      ? proxyImageUrl(rawImageUrl)
      : null;
  const radius = size <= 24 ? 1.25 : 1.5;

  const selectedName =
    branding?.name !== undefined
      ? "name"
      : branding?.legalName !== undefined
        ? "legalName"
        : undefined;
  const credits = contributorsForRecordFields(branding ?? {}, [
    ...(selectedName ? [selectedName] : []),
    ...(branding?.color ? ["color"] : []),
    ...(imageUrl
      ? photo
        ? ["catalogueLogo.qid", "catalogueLogo.file"]
        : [branding?.logoUrl ? "logoUrl" : "imageUrl"]
      : []),
  ]);
  const mark =
    imageUrl && rawImageUrl ? (
      <Box
        component="img"
        src={imageUrl}
        alt={branding?.name ?? fallbackName ?? "Brand"}
        onError={() => setFailedImageUrl(rawImageUrl)}
        sx={{
          width: size,
          height: size,
          display: "block",
          flexShrink: 0,
          objectFit: "contain",
          borderRadius: radius,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
          p: size <= 24 ? 0.25 : 0.5,
        }}
      />
    ) : (
      ((!branding ? fallbackMark : undefined) ?? (
        <Box
          sx={{
            width: size,
            height: size,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            borderRadius: radius,
            border: "1px solid",
            borderColor: "divider",
            bgcolor: branding?.color ? `${branding.color}22` : "action.hover",
            color: branding?.color ?? "text.primary",
          }}
        >
          <Typography
            component="span"
            sx={{
              fontSize: size <= 24 ? 11 : 13,
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            {fallbackInitial(branding, fallbackName)}
          </Typography>
        </Box>
      ))
    );
  const notice =
    credits.length > 0 || (photo && imageUrl) ? (
      <>
        {photo && imageUrl && (
          <Box sx={{ color: "text.secondary", fontSize: "0.6875rem", minWidth: 0 }}>
            <PhotoAttribution photo={photo} compact color="inherit" />
          </Box>
        )}
        {credits.length > 0 && (
          <AttributionStrip
            attributions={credits}
            variant="plain"
            provenanceDisplay={children ? "details" : "chips"}
          />
        )}
      </>
    ) : null;
  if (!children)
    return (
      <Box>
        {mark}
        {notice}
      </Box>
    );
  const showMark = Boolean(branding || fallbackMark);
  const content = (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: showMark ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)",
        columnGap: 1.25,
        alignItems: "start",
        minWidth: 0,
      }}
    >
      {showMark && mark}
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
  if (renderRow) return renderRow({ content, credits: notice });
  return (
    <Box sx={{ minWidth: 0 }}>
      {content}
      {notice}
    </Box>
  );
}
