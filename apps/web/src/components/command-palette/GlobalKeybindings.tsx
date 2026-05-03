"use client";

import { useCallback, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { useCommandSources } from "./useCommandSources";
import { useGlobalKeybindings } from "./useGlobalKeybindings";

export function GlobalKeybindings() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Stable references so useCommandSources' useMemo deps don't churn.
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  // Single source of truth — palette, shortcuts dialog, and listener all
  // share the same Command[] instance.
  const commands = useCommandSources({ openShortcutsDialog: openShortcuts });

  useGlobalKeybindings({
    commands,
    isShortcutsDialogOpen: shortcutsOpen,
  });

  return (
    <>
      <CommandPalette commands={commands} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} commands={commands} />
    </>
  );
}
