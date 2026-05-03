"use client";

import { useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { useCommandSources } from "./useCommandSources";
import { useGlobalKeybindings } from "./useGlobalKeybindings";

export function GlobalKeybindings() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const commands = useCommandSources({ openShortcutsDialog: () => setShortcutsOpen(true) });

  useGlobalKeybindings({
    commands,
    onOpenShortcuts: () => setShortcutsOpen(true),
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
      const el = document.querySelector<HTMLInputElement>(
        'input[aria-label="search"], input[placeholder*="Search"], input[placeholder*="Suchen"]',
      );
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
      <CommandPalette onOpenShortcuts={() => setShortcutsOpen(true)} />
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        commands={commands}
      />
    </>
  );
}
