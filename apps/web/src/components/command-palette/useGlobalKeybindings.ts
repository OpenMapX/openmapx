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
import { SEARCH_INPUT_ID } from "./constants";

const SEQUENCE_TIMEOUT_MS = 1200;

// Pre-parsed once at module load so the keydown handler doesn't re-parse on
// every keystroke. The handler indexes `[0]`, so this must stay a single chord.
const PALETTE_TOGGLE = parseShortcut("Mod+K");
if (PALETTE_TOGGLE.length !== 1) {
  throw new Error("PALETTE_TOGGLE must be a single chord");
}
const PALETTE_TOGGLE_CHORD = PALETTE_TOGGLE[0];

interface Options {
  commands: Command[];
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
  const { commands, isShortcutsDialogOpen } = opts;
  // Refs: avoid re-binding the listener every render; avoid storing in state.
  const commandsRef = useRef(commands);
  const buffer = useRef<KeyChord[]>([]);
  const timer = useRef<number | null>(null);
  const isShortcutsOpenRef = useRef(isShortcutsDialogOpen);

  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
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
      if (matchChord(event, PALETTE_TOGGLE_CHORD)) {
        event.preventDefault();
        useCommandPaletteStore.getState().toggle();
        clearBuffer();
        return;
      }

      // 3. Suppress everything else when the user is typing in an input,
      // or when one of our own dialogs (palette, shortcuts help) is open so
      // keystrokes inside those surfaces don't fire global shortcuts.
      // (Other MUI Dialogs are not currently checked — Esc and ⌘K above
      // are the only bindings expected to work over them.)
      if (isTypingTarget(event.target)) {
        clearBuffer();
        return;
      }
      if (useCommandPaletteStore.getState().isOpen || isShortcutsOpenRef.current) {
        clearBuffer();
        return;
      }

      // 4. Built-in "/" — focus the SearchBar. Plain "/" only; modifier
      // combos belong to the browser/OS. Inherits the typing-target,
      // dialog-open, and mobile-guard suppression rules above.
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
        if (el) {
          event.preventDefault();
          el.focus();
          el.select();
        }
        clearBuffer();
        return;
      }

      // 5. Match against registered command shortcuts (sequences allowed).
      // Includes `?` via the `actions.shortcuts` command, which is the single
      // source of truth for opening the keyboard-shortcuts help.
      const sequences: KeySequence[] = [];
      const cmdsForSeq: Command[] = [];
      for (const c of commandsRef.current) {
        if (c.shortcut) {
          sequences.push(c.shortcut);
          cmdsForSeq.push(c);
        }
      }

      const result = matchSequence(buffer.current, event, sequences);
      if (result.kind === "match") {
        event.preventDefault();
        const cmd = cmdsForSeq[result.matchedIndex];
        if (cmd) {
          try {
            cmd.run();
          } catch (e) {
            console.error(`[command-palette] '${cmd.id}' failed:`, e);
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

// Re-export for callers that want to register their own non-command shortcuts.
export { PANEL };
