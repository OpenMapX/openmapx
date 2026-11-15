"use client";

import Box from "@mui/material/Box";
import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { usePersonalTimelineStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { TimelineEntryRow } from "./TimelineEntryRow";

export function TimelineEntryList({ day }: { day: PersonalTimelineDayV1 }) {
  const t = useTranslations("timeline");
  const selectedEntryId = usePersonalTimelineStore((state) => state.selectedEntryId);
  const selectEntry = usePersonalTimelineStore((state) => state.selectEntry);
  const entryElements = useRef(new Map<string, HTMLButtonElement>());
  const selectionFromList = useRef<string | null>(null);
  const entries = [...day.entries].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );

  useEffect(() => {
    if (!selectedEntryId) return;
    if (selectionFromList.current === selectedEntryId) {
      selectionFromList.current = null;
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    entryElements.current.get(selectedEntryId)?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "nearest",
    });
  }, [selectedEntryId]);

  return (
    <Box component="ul" aria-label={t("entriesAriaLabel")} sx={{ listStyle: "none", p: 0, m: 0 }}>
      {entries.map((entry, index) => (
        <Box component="li" key={entry.id} sx={{ minWidth: 0 }}>
          <TimelineEntryRow
            entry={entry}
            before={entries[index - 1]}
            after={entries[index + 1]}
            // A rule above each place, as between the stops of a trip.
            divider={index > 0 && entry.type === "visit"}
            timeZone={day.timeZone}
            selected={entry.id === selectedEntryId}
            elementRef={(element) => {
              if (element) entryElements.current.set(entry.id, element);
              else entryElements.current.delete(entry.id);
            }}
            onSelect={() => {
              selectionFromList.current = entry.id;
              selectEntry(entry.id);
            }}
          />
        </Box>
      ))}
    </Box>
  );
}
