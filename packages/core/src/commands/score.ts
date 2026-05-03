import type { Command, CommandGroup } from "./types";

/** Minimum score to keep a row in the filtered list. */
export const SCORE_CUTOFF = 0.1;

/**
 * Per-group priority added on top of the match score so that, when two rows
 * tie on substring/keyword match, "core" command types (layers, panels) win
 * over more specialised ones (overlays). Categories and actions are neutral.
 */
const GROUP_PRIORITY: Record<CommandGroup, number> = {
  layers: 0.1,
  panels: 0.05,
  categories: 0,
  overlays: 0,
  actions: 0,
  search: -0.05,
};

/**
 * Score a Command against a query.
 *
 * Substring/prefix matching plus multi-word token matching — no fuzzy bigram
 * dice. With a curated command list (~30-50 items) where users can read full
 * labels, exact substring matching is more predictable than fuzzy similarity,
 * which surfaces unrelated rows for short queries via accidental letter
 * overlap.
 *
 * For multi-word queries (e.g. "overlay weather") that aren't a contiguous
 * substring of the label, every token must appear somewhere across the
 * label/sublabel/keywords for the command to match.
 */
export function scoreCommand(query: string, cmd: Command): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const label = cmd.label.toLowerCase();
  const sublabel = cmd.sublabel?.toLowerCase() ?? "";
  const keywords = (cmd.keywords ?? []).map((k) => k.toLowerCase());

  let score = 0;

  if (label === q) {
    score = 1.0;
  } else if (label.startsWith(q)) {
    score = 0.8;
  } else if (label.includes(q)) {
    score = 0.5;
  }

  for (const k of keywords) {
    if (k === q) score = Math.max(score, 0.7);
    else if (k.startsWith(q)) score = Math.max(score, 0.6);
    else if (k.includes(q)) score = Math.max(score, 0.4);
  }

  if (sublabel.includes(q)) {
    score = Math.max(score, 0.3);
  }

  // Multi-word fallback: tokens may appear out of order or split across
  // label / sublabel / keywords (e.g. "overlay weather" against
  // "Toggle overlay: Weather Overlay").
  if (score === 0) {
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      const haystack = `${label} ${sublabel} ${keywords.join(" ")}`;
      if (tokens.every((tok) => haystack.includes(tok))) {
        score = 0.35;
      }
    }
  }

  if (score > 0 && cmd.isActive?.()) {
    score += 0.05;
  }

  if (score > 0) {
    score += GROUP_PRIORITY[cmd.group] ?? 0;
  }

  return score;
}
