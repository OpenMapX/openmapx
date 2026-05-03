export type CommandGroup = "layers" | "overlays" | "panels" | "categories" | "actions" | "search";

export interface KeyChord {
  /** Lower-cased key (e.g. "k", "/", "?", "escape", "enter", "arrowup"). */
  key: string;
  /** Cross-platform "primary" modifier — Cmd on macOS, Ctrl elsewhere. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** A sequence of one or more chords (length 1 = chord; length 2 = sequence like "g s"). */
export type KeySequence = KeyChord[];

// biome-ignore lint/suspicious/noConfusingVoidType: command runners are side-effectful; returning false is the only special case.
export type CommandRunResult = false | void;

export interface Command {
  /** Stable id, e.g. "layers.satellite". */
  id: string;
  group: CommandGroup;
  /** Already-i18n'd display label. */
  label: string;
  /** Optional secondary line. */
  sublabel?: string;
  /** Looked up in the web `commandIcons.tsx` map. */
  iconKey: string;
  /**
   * Optional SVG path data (Material symbol path "d" attribute). When set,
   * the row renders this inline instead of looking up `iconKey`. Used for
   * categories whose icons aren't pre-registered in the icon map.
   */
  iconPath?: string;
  /** Optional global shortcut. */
  shortcut?: KeySequence;
  /** Extra terms used in fuzzy match. */
  keywords?: string[];
  /** When true, the row renders a "currently on" indicator. */
  isActive?: () => boolean;
  /**
   * Side-effectful runner. If the function explicitly returns `false` the palette
   * stays open (used for toggles); any other return value closes the palette.
   */
  run: () => CommandRunResult;
}
