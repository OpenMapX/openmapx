"use client";

import type { ReactNode } from "react";
import { LayerPreviewTile } from "./LayerPreviewTile";

export function DesktopMoreTile({
  item,
  label,
  labelWidth = 96,
  onClick,
}: {
  item: { preview: ReactNode; selected?: boolean };
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
