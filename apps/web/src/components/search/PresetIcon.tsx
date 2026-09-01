"use client";

import PlaceIcon from "@mui/icons-material/Place";
import { BRAND } from "@/integration-api/runtime/theme";

interface PresetIconProps {
  iconKey: string | undefined;
  size?: number;
  /** Override the icon color. Defaults to the brand colour so preset results match
   *  the chip-bar category icons in the same dropdown. */
  color?: string;
}

/** Render an iD preset icon by its key (e.g. "maki-fuel", "temaki-helicopter").
 *  Uses CSS `mask-image` so the SVG's silhouette is filled with the brand colour
 *  (matching chip-category icons), independent of the asset's own fill. Maki and
 *  Temaki SVGs are copied into `/icons/{maki,temaki}/` at build time (see
 *  `apps/web/scripts/copy-preset-icons.mjs`). Unknown prefixes (e.g. `fas-`) fall
 *  back to a generic Material `place` icon. */
export function PresetIcon({ iconKey, size = 20, color = BRAND }: PresetIconProps) {
  if (!iconKey) {
    return <PlaceIcon sx={{ fontSize: size, color }} />;
  }

  let src: string | undefined;
  if (iconKey.startsWith("maki-")) {
    src = `/icons/maki/${iconKey.slice("maki-".length)}.svg`;
  } else if (iconKey.startsWith("temaki-")) {
    src = `/icons/temaki/${iconKey.slice("temaki-".length)}.svg`;
  }

  if (!src) {
    return <PlaceIcon sx={{ fontSize: size, color }} />;
  }

  const maskValue = `url(${src}) center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
        backgroundColor: color,
        mask: maskValue,
        WebkitMask: maskValue,
      }}
    />
  );
}
