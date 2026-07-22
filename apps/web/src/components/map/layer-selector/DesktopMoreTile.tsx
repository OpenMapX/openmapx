"use client";

import type { ReactNode } from "react";
import { LayerPreviewTile } from "./LayerPreviewTile";

export function DesktopMoreTile({
  item,
  label,
  labelWidth = 96,
  onClick,
  disabled,
  children,
}: {
  item: { preview: ReactNode; selected?: boolean };
  label: string;
  labelWidth?: number;
  onClick?: () => void;
  disabled?: boolean;
  /** Rendered under the label — used for the zoom-gate hint. */
  children?: ReactNode;
}) {
  return (
    <LayerPreviewTile
      preview={item.preview}
      label={label}
      selected={item.selected}
      size={48}
      labelWidth={labelWidth}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </LayerPreviewTile>
  );
}
