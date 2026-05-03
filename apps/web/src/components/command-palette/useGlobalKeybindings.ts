"use client";

import {
  type Command,
  type KeyChord,
  type KeySequence,
  matchChord,
  matchSequence,
  PANEL,
  parseShortcut,
  useCommandPaletteStore,
  useDirectionsStore,
  useMenuStore,
  useSidebarStore,
} from "@openmapx/core";
import { useEffect, useRef } from "react";

const SEQUENCE_TIMEOUT_MS = 1200;

// Pre-parsed once at module load so the keydown handler doesn't re-parse on
// every keystroke.
const PALETTE_TOGGLE = parseShortcut("Mod+K");
const HELP_SEQ = parseShortcut("?");

interface Options {
  commands: Command[];
  onOpenShortcuts: () => void;
  /** Set to true when KeyboardShortcutsDialog is open (for Esc precedence). */
  isShortcutsDialogOpen: boolean;
}

/** Returns true if keyboard event target is an input/textarea/contenteditable. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function isMobileLike(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: none)").matches;
}

export function useGlobalKeybindings(opts: Options) {
  const { commands, onOpenShortcuts, isShortcutsDialogOpen } = opts;
  // Refs: avoid re-binding the listener every render; avoid storing in state.
  const commandsRef = useRef(commands);
  const buffer = useRef<KeyChord[]>([]);
  const timer = useRef<number | null>(null);
  const onOpenShortcutsRef = useRef(onOpenShortcuts);
  const isShortcutsOpenRef = useRef(isShortcutsDialogOpen);

  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
  useEffect(() => {
    onOpenShortcutsRef.current = onOpenShortcuts;
  }, [onOpenShortcuts]);
  useEffect(() => {
    isShortcutsOpenRef.current = isShortcutsDialogOpen;
  }, [isShortcutsDialogOpen]);

  // listener uses refs intentionally
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isMobileLike()) return;

    const clearBuffer = () => {
      buffer.current = [];
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };

    const handleEsc = () => {
      // Stack: palette → shortcuts dialog → sidebar → menu → blur
      const palette = useCommandPaletteStore.getState();
      if (palette.isOpen) {
        palette.close();
        return true;
      }
      if (isShortcutsOpenRef.current) {
        // Defer to MUI: returning false leaves Esc unhandled here so the
        // Dialog's own onClose fires and closes the shortcuts dialog
        // (we explicitly do NOT preventDefault for that case).
        return false;
      }
      const directions = useDirectionsStore.getState();
      if (directions.isOpen) {
        directions.close();
        return true;
      }
      const sidebar = useSidebarStore.getState();
      if (sidebar.activeSidebarId) {
        sidebar.closeSidebar();
        return true;
      }
      const menu = useMenuStore.getState();
      if (menu.isOpen) {
        menu.close();
        return true;
      }
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
        return true;
      }
      return false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 1. Esc — handle from anywhere, even inputs
      if (event.key === "Escape") {
        const handled = handleEsc();
        if (handled) event.preventDefault();
        clearBuffer();
        return;
      }

      // 2. Cmd+K — handle from anywhere, even inputs
      if (matchChord(event, PALETTE_TOGGLE[0])) {
        event.preventDefault();
        useCommandPaletteStore.getState().toggle();
        clearBuffer();
        return;
      }

      // 3. Suppress everything else when typing in an input or in a Dialog
      if (isTypingTarget(event.target)) {
        clearBuffer();
        return;
      }
      if (useCommandPaletteStore.getState().isOpen || isShortcutsOpenRef.current) {
        clearBuffer();
        return;
      }

      // 4. Match against registered command shortcuts (sequences allowed)
      const sequences: KeySequence[] = [];
      const cmdsForSeq: Command[] = [];
      for (const c of commandsRef.current) {
        if (c.shortcut) {
          sequences.push(c.shortcut);
          cmdsForSeq.push(c);
        }
      }
      // Built-in: ? opens shortcuts help (no underlying command shortcut bound)
      sequences.push(HELP_SEQ);

      const result = matchSequence(buffer.current, event, sequences);
      if (result.kind === "match") {
        event.preventDefault();
        // Find the matched sequence
        const matched = result.consumed;
        const sameLen = (a: KeyChord[], b: KeyChord[]) =>
          a.length === b.length && a.every((c, i) => chordEqual(c, b[i]));
        if (sameLen(matched, HELP_SEQ)) {
          onOpenShortcutsRef.current();
        } else {
          const idx = sequences.findIndex((s) => sameLen(s, matched));
          if (idx >= 0 && idx < cmdsForSeq.length) {
            const cmd = cmdsForSeq[idx];
            try {
              cmd.run();
            } catch (e) {
              console.error(`[command-palette] '${cmd.id}' failed:`, e);
            }
          }
        }
        clearBuffer();
        return;
      }

      if (result.kind === "partial") {
        buffer.current = result.buffered;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(clearBuffer, SEQUENCE_TIMEOUT_MS);
        return;
      }

      // miss — clear any pending sequence
      clearBuffer();
    };

    const onBlur = () => clearBuffer();

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      clearBuffer();
    };
  }, []);
}

function chordEqual(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key === b.key &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.alt ?? false) === (b.alt ?? false)
  );
}

// Re-export for callers that want to register their own non-command shortcuts.
export { PANEL };
