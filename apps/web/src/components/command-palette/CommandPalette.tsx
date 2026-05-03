"use client";

import Dialog from "@mui/material/Dialog";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  type Command,
  type CommandGroup,
  getPlatform,
  SCORE_CUTOFF,
  scoreCommand,
  useCommandPaletteStore,
  useSearchStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPaletteFooter } from "./CommandPaletteFooter";
import { CommandPaletteInput } from "./CommandPaletteInput";
import { buildDefaultCommandRows, CommandPaletteList } from "./CommandPaletteList";
import { COMMAND_PALETTE_LISTBOX_ID, SEARCH_INPUT_ID } from "./constants";

interface Props {
  /** Command list — provided by `GlobalKeybindings` so the palette, the
   * shortcuts dialog, and the global listener all share a single instance. */
  commands: Command[];
}

// Synthetic id (double-underscore prefix) so it can't collide with any real
// command id in the `search` group.
const SEARCH_FALLBACK_ID = "__search-fallback__";

export function CommandPalette({ commands }: Props) {
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down("sm"));
  const t = useTranslations("commandPalette");

  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const close = useCommandPaletteStore((s) => s.close);
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);

  const setSearchQuery = useSearchStore((s) => s.setQuery);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [highlight, setHighlight] = useState(0);
  // Groups the user has expanded via a "+N more" row in this open session.
  // Reset on each palette open so reopening starts collapsed.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<CommandGroup>>(() => new Set());

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      setHighlight(0);
    },
    [setQuery],
  );

  const handleExpandGroup = useCallback((group: CommandGroup) => {
    setExpandedGroups((prev) => {
      if (prev.has(group)) return prev;
      const next = new Set(prev);
      next.add(group);
      return next;
    });
  }, []);

  // Hand-off to SearchBar — runs the user's query through the regular search flow.
  const handleSearchOnMap = useCallback(() => {
    const q = query.trim();
    close();
    if (!q) return;
    requestAnimationFrame(() => {
      setSearchQuery(q);
      const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
      el?.focus();
    });
  }, [close, query, setSearchQuery]);

  // Ranked filtered list when query is present, otherwise the raw command list.
  // When filtering, the synthetic "Search '<q>' on map" row is always appended so
  // it can be navigated by ↑↓ alongside real matches.
  const ranked = useMemo<Command[] | null>(() => {
    const q = query.trim();
    if (!q) return null;
    const matches = commands
      .map((c) => ({ c, s: scoreCommand(q, c) }))
      .filter((x) => x.s >= SCORE_CUTOFF)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    const fallback: Command = {
      id: SEARCH_FALLBACK_ID,
      group: "search",
      label: t("searchOnMap", { query: q }),
      iconKey: "search",
      run: handleSearchOnMap,
    };
    return [...matches, fallback];
  }, [commands, query, t, handleSearchOnMap]);

  const defaultRows = useMemo(
    () =>
      buildDefaultCommandRows(commands, {
        expandedGroups,
        onExpandGroup: handleExpandGroup,
        t: (key, values) => t(key, values),
      }),
    [commands, expandedGroups, handleExpandGroup, t],
  );
  const visible = useMemo(() => ranked ?? defaultRows, [ranked, defaultRows]);
  const noRealMatches = ranked !== null && ranked.length === 1; // only the fallback

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setHighlight(0);
      setExpandedGroups(new Set());
      // Auto-select existing text on re-open
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isOpen]);

  // Keep the highlighted row scrolled into view as the user arrow-keys past the
  // visible area.
  useEffect(() => {
    const cmd = visible[highlight];
    if (!cmd) return;
    const el = document.getElementById(`command-row-${cmd.id}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, visible]);

  const runCommand = useCallback(
    (cmd: Command, event?: { metaKey?: boolean; ctrlKey?: boolean }) => {
      // Platform-aware "keep open" modifier so Ctrl+Enter doesn't trigger
      // it on macOS (where the user expects ⌘+Enter only).
      const isMac = getPlatform() === "mac";
      const keepOpen = isMac ? !!event?.metaKey : !!event?.ctrlKey;
      try {
        const result = cmd.run();
        if (!keepOpen && result !== false) close();
      } catch (e) {
        console.error(`[command-palette] '${cmd.id}' failed:`, e);
      }
    },
    [close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (visible.length === 0 ? 0 : (h + 1) % visible.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (visible.length === 0 ? 0 : (h - 1 + visible.length) % visible.length));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = visible[highlight];
        if (cmd) {
          runCommand(cmd, { metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        }
        return;
      }
      // Escape is handled by the global keybindings listener.
    },
    [visible, highlight, runCommand],
  );

  const selected = visible[highlight] ?? null;
  const selectedDomId = selected ? `command-row-${selected.id}` : null;

  return (
    <Dialog
      open={isOpen}
      onClose={close}
      fullScreen={isXs}
      maxWidth="sm"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            position: (isXs ? undefined : "absolute") as "absolute" | undefined,
            top: isXs ? undefined : 80,
            m: isXs ? 0 : 2,
            borderRadius: isXs ? 0 : 2,
            maxHeight: isXs ? "100dvh" : "70dvh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          },
        },
        backdrop: {
          sx: { backgroundColor: "rgba(0,0,0,0.32)" },
        },
      }}
    >
      <CommandPaletteInput
        ref={inputRef}
        query={query}
        onQueryChange={handleQueryChange}
        onClose={close}
        onKeyDown={handleKeyDown}
        activeDescendantId={selectedDomId}
      />
      <div style={{ overflowY: "auto", flex: 1 }}>
        {noRealMatches && (
          <Typography sx={{ px: 2, py: 1.5, color: "text.secondary", fontSize: 14 }}>
            {t("noResults")}
          </Typography>
        )}
        <CommandPaletteList
          defaultRows={defaultRows}
          rankedOverride={ranked}
          selectedId={selected?.id ?? null}
          listboxId={COMMAND_PALETTE_LISTBOX_ID}
          onRun={(cmd, e) => {
            const evt = e as unknown as { metaKey?: boolean; ctrlKey?: boolean };
            runCommand(cmd, evt);
          }}
        />
      </div>
      <CommandPaletteFooter />
    </Dialog>
  );
}
