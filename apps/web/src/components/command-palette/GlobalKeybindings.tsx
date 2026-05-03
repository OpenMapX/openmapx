"use client";

import { useCommandPaletteStore } from "@openmapx/core";
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

  // Built-in: "/" focuses the SearchBar input. Suppressed while the palette
  // or shortcuts dialog is open so it doesn't focus the SearchBar behind a
  // modal, and (like the rest of the listener) while the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      // Plain "/" only — don't hijack browser/OS shortcuts like Ctrl+/, Cmd+/.
      // (Shift+/ produces "?" so it never reaches this branch on most layouts.)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (useCommandPaletteStore.getState().isOpen) return;
      if (shortcutsOpen) return;
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
  }, [shortcutsOpen]);

  return (
    <>
      <CommandPalette onOpenShortcuts={openShortcuts} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} commands={commands} />
    </>
  );
}
