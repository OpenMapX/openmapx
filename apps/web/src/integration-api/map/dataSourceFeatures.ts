import type { DataSourceMeta, DataSourceResult } from "@openmapx/core";
import type { Translatable } from "@openmapx/integration-framework/strings";
import {
  contributorsForField,
  contributorsForRecordFields,
  serializeContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";
import type { ExpressionSpecification, Map as MaplibreMap } from "maplibre-gl";

/**
 * Buckets a data-source result's live availability into a marker color state.
 * `unknown` covers results with no live coverage (or a reported zero-capacity
 * station), so the marker falls back to its static variant color.
 */
export function availStateOf(result: {
  availability?: { available: number; total: number };
}): "available" | "busy" | "unknown" {
  const a = result.availability;
  if (!a || a.total === 0) return "unknown";
  return a.available > 0 ? "available" : "busy";
}

export function buildGeoJson(
  results: DataSourceResult[],
  translate: (value: Translatable | undefined) => string | undefined,
  imageId?: string,
  markerStyle?: DataSourceMeta["markerStyle"],
) {
  return {
    type: "FeatureCollection" as const,
    features: results.map((r) => {
      const circleFields = ["coordinates"];
      if (r.availability) {
        circleFields.push("availability.total");
        if (r.availability.total > 0) circleFields.push("availability.available");
      }
      if (availStateOf(r) === "unknown" && Object.keys(markerStyle?.variantColors ?? {}).length)
        circleFields.push("variant");
      if (markerStyle?.inactiveOpacity !== 1 && r.status) circleFields.push("status");
      const marker = contributorsForRecordFields(r, imageId ? ["coordinates"] : circleFields);
      const summaryField = r.labelSummary ? "labelSummary" : "summary";
      const summary = translate(r[summaryField]) ?? "";
      const nameField = r.name ? "name" : "fallbackName";
      const labelFields = ["coordinates", nameField];
      const logoFields = [
        "coordinates",
        "branding.logoUrl",
        ...(markerStyle?.inactiveOpacity !== 1 && r.status ? ["status"] : []),
      ];
      return withFeatureContributors(
        {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: r.coordinates },
          properties: {
            id: r.id,
            name: r.name || (translate(r.fallbackName) ?? ""),
            source: r.source,
            variant: r.variant,
            status: r.status ?? "",
            summary,
            operator: r.operator ?? "",
            kind: r.kind ?? "",
            availState: availStateOf(r),
            logoUrl: r.branding?.logoUrl ?? "",
            ...(imageId ? { imageId } : {}),
            _mapMarkerAttributions: serializeContributors(marker),
            _mapHaloAttributions: serializeContributors(
              contributorsForRecordFields(r, circleFields),
            ),
            _mapLabelAttributions: serializeContributors(
              contributorsForRecordFields(r, labelFields),
            ),
            _mapSummaryLabelAttributions: serializeContributors(
              contributorsForRecordFields(r, [...labelFields, ...(summary ? [summaryField] : [])]),
            ),
            _mapLogoSelectionAttributions: serializeContributors(
              contributorsForRecordFields(r, logoFields),
            ),
            _mapLogoFileAttributions: serializeContributors(
              contributorsForField(r, "branding.logoUrl"),
            ),
          },
        },
        marker,
      );
    }),
  };
}

/** The tracks of the results that carry one, as lines coloured like their markers. */
export function buildTrackGeoJson(results: DataSourceResult[]) {
  return {
    type: "FeatureCollection" as const,
    features: results.flatMap((r) => {
      if (!r.track || r.track.length < 2) return [];
      const contributors = contributorsForRecordFields(r, [
        "track",
        "variant",
        ...(r.status ? ["status"] : []),
      ]);
      return [
        withFeatureContributors(
          {
            type: "Feature" as const,
            geometry: { type: "LineString" as const, coordinates: r.track },
            properties: {
              id: r.id,
              variant: r.variant,
              status: r.status ?? "",
              _mapTrackAttributions: serializeContributors(contributors),
            },
          },
          contributors,
        ),
      ];
    }),
  };
}

/**
 * Build a MapLibre `match` expression for circle-color using variantColors.
 */
export function buildVariantColorExpression(
  markerStyle: DataSourceMeta["markerStyle"],
): ExpressionSpecification {
  const entries = Object.entries(markerStyle.variantColors);
  if (entries.length === 0) return ["literal", markerStyle.defaultColor];

  const expr: unknown[] = ["match", ["get", "variant"]];
  for (const [variant, color] of entries) {
    expr.push(variant, color);
  }
  expr.push(markerStyle.defaultColor);
  return expr as ExpressionSpecification;
}

/**
 * Paint for a data source's circle markers: live availability (green/amber)
 * where a result reports it, otherwise the variant colour, with
 * non-operational results drawn at the source's inactive opacity.
 */
export function dataSourceCirclePaint(
  markerStyle: DataSourceMeta["markerStyle"],
  radius: number | ExpressionSpecification = 6,
) {
  const inactive: ExpressionSpecification = [
    "case",
    ["==", ["get", "status"], "non-operational"],
    markerStyle.inactiveOpacity,
    1,
  ];
  return {
    "circle-radius": radius,
    "circle-color": [
      "match",
      ["get", "availState"],
      "available",
      "#2E7D32",
      "busy",
      "#F9A825",
      buildVariantColorExpression(markerStyle),
    ] as ExpressionSpecification,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 1.5,
    "circle-opacity": inactive,
    "circle-stroke-opacity": inactive,
  };
}

/** Paint for a moving result's track: thin and faint under the markers, where it has just been. */
export function dataSourceTrackPaint(markerStyle: DataSourceMeta["markerStyle"]) {
  return {
    "line-color": buildVariantColorExpression(markerStyle),
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 14, 3] as ExpressionSpecification,
    "line-opacity": [
      "case",
      ["==", ["get", "status"], "non-operational"],
      0.25,
      0.55,
    ] as ExpressionSpecification,
  };
}

/** Layout for a track line. */
export const DATA_SOURCE_TRACK_LAYOUT = { "line-cap": "round", "line-join": "round" } as const;

/** Rasterized glyphs by their SVG, so a style rebuild adds them back synchronously. */
const glyphPixels = new Map<string, ImageData>();

function glyphSvg(iconPath: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><path d="${iconPath}" fill="white"/></svg>`;
}

/**
 * Rasterize a data source's white glyph. Draw its glyph layer only once this
 * settles, so the glyph is added synchronously and never laid out missing.
 */
export function prepareDataSourceGlyph(iconPath: string): Promise<void> {
  const svg = glyphSvg(iconPath);
  if (glyphPixels.has(svg)) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image(48, 48);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 48;
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(img, 0, 0, 48, 48);
        glyphPixels.set(svg, context.getImageData(0, 0, 48, 48));
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * A data source's glyph drawn white over its circle markers, so sources shown
 * side by side stay apart even where their colours meet. The circle stays the
 * marker: it takes the clicks and carries the credits, while a symbol image
 * does not count as seen. Returns the image loader, keyed by id, and the
 * symbol layer's layout and paint; call `prepareDataSourceGlyph` first.
 */
export function dataSourceGlyphOverlay(
  imageId: string,
  markerStyle: DataSourceMeta["markerStyle"],
) {
  const svg = glyphSvg(markerStyle.iconPath);
  return {
    images: {
      [imageId]: (map: MaplibreMap) => {
        const pixels = glyphPixels.get(svg);
        if (pixels && !map.hasImage(imageId)) map.addImage(imageId, pixels, { pixelRatio: 2 });
      },
    },
    layout: {
      "icon-image": imageId,
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        0.45,
        14,
        0.6,
      ] as ExpressionSpecification,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: {
      "icon-opacity": [
        "case",
        ["==", ["get", "status"], "non-operational"],
        markerStyle.inactiveOpacity,
        1,
      ] as ExpressionSpecification,
    },
  };
}
