import type { AlertColor } from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Link from "next/link";
import type { ReactNode } from "react";
import { CompactAlert } from "./CompactAlert";

export interface CompactAlertListItem {
  id: string;
  severity: AlertColor;
  message: ReactNode;
  href: string;
  actionLabel: string;
}

interface CompactAlertListProps {
  items: CompactAlertListItem[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  collapsedItemCount?: number;
}

export function CompactAlertList({
  items,
  expanded,
  onExpandedChange,
  collapsedItemCount = 3,
}: CompactAlertListProps) {
  const visibleItems = expanded ? items : items.slice(0, collapsedItemCount);
  const hiddenItemCount = items.length - collapsedItemCount;

  return (
    <Stack sx={{ gap: 1 }}>
      {visibleItems.map((item) => (
        <CompactAlert
          key={item.id}
          severity={item.severity}
          variant="outlined"
          action={
            <Button component={Link} href={item.href} size="small" color="inherit">
              {item.actionLabel}
            </Button>
          }
        >
          {item.message}
        </CompactAlert>
      ))}
      {hiddenItemCount > 0 && (
        <Button
          size="small"
          onClick={() => onExpandedChange(!expanded)}
          sx={{ alignSelf: "flex-start" }}
        >
          {expanded ? "Show less" : `Show ${hiddenItemCount} more`}
        </Button>
      )}
    </Stack>
  );
}
