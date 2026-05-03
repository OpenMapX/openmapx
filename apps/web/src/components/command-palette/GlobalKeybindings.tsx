"use client";

import { useCallback, useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { SEARCH_INPUT_ID } from "./constants";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { useCommandSources } from "./useCommandSources";
import { useGlobalKeybindings } from "./useGlobalKeybindings";

export function GlobalKeybindings() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Stable references so useCommandSources' useMemo deps don't churn.
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const commands = useCommandSources({ openShortcutsDialog: openShortcuts });

  useGlobalKeybindings({
    commands,
    onOpenShortcuts: openShortcuts,
    isShortcutsDialogOpen: shortcutsOpen,
  });

  // Built-in: "/" focuses the SearchBar input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <CommandPalette onOpenShortcuts={openShortcuts} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} commands={commands} />
    </>
  );
}
