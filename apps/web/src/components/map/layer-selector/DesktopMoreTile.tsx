"use client";

import { LayerPreviewTile } from "./LayerPreviewTile";
import type { DesktopMoreOption } from "./layerSelectorConfig";

export function DesktopMoreTile({
  item,
  label,
  labelWidth = 96,
  onClick,
}: {
  item: DesktopMoreOption;
  label: string;
  labelWidth?: number;
  onClick?: () => void;
}) {
  return (
    <LayerPreviewTile
      preview={item.preview}
      label={label}
      selected={item.selected}
      size={48}
      labelWidth={labelWidth}
      onClick={onClick}
    />
  );
}
