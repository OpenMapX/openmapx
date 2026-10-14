import escapeHtml from "escape-html";
import { type AttributionPresentation, parseAttributionHtml } from "./attribution";

/** Whole credited fragment, never a prefix of another publisher's name. */
function containsNoticeText(candidate: string, notice: string): boolean {
  if (!notice) return false;
  let start = candidate.indexOf(notice);
  while (start !== -1) {
    const before = candidate.slice(0, start).trimEnd();
    const after = candidate.slice(start + notice.length).trimStart();
    if (
      (!before ||
        notice.startsWith("©") ||
        before.endsWith("©") ||
        before.endsWith("|") ||
        before.endsWith("·")) &&
      (!after || after.startsWith("(") || after.startsWith("|") || after.startsWith("·"))
    )
      return true;
    start = candidate.indexOf(notice, start + 1);
  }
  return false;
}

/**
 * Compare complete credited fragments and parsed notices: a linked
 * basemap notice can cover an overlay's plain copy of the same wording. Only
 * discard that copy if the retained notice preserves every link, including
 * its label and target. Equal link sets keep the first occurrence; distinct or
 * complementary licence/publisher links remain separate.
 */
export function dedupeAttributionHtml(items: string[]): string[] {
  const notices = items.map((html) => ({ html, ...parseAttributionHtml(html) }));
  type Notice = (typeof notices)[number];
  const coversLinks = (candidate: Notice, original: Notice) =>
    original.links.every((link) =>
      candidate.links.some((other) => other.label === link.label && other.url === link.url),
    );
  return notices
    .filter(
      (notice, i) =>
        notice.html.length > 0 &&
        !notices.some((other, j) => {
          if (j === i) return false;
          if (notice.text === other.text) {
            return coversLinks(other, notice) && (!coversLinks(notice, other) || j < i);
          }
          return (
            containsNoticeText(other.text, notice.text) &&
            coversLinks(other, notice) &&
            (other.text.length > notice.text.length || j < i)
          );
        }),
    )
    .map(({ html }) => html);
}

export interface VisibleAttribution {
  html: string;
  logos: AttributionPresentation["logos"];
  prominence?: "normal";
}
export interface AttributionPresentationGroup {
  fullHtml: string[];
  visible: VisibleAttribution[];
}

/** Keep the longer wording and every link, only when link spans are unambiguous. */
function mergeVisibleNotice(first: string, second: string): string | undefined {
  const a = parseAttributionHtml(first);
  const b = parseAttributionHtml(second);
  const text = containsNoticeText(a.text, b.text)
    ? a.text
    : containsNoticeText(b.text, a.text)
      ? b.text
      : undefined;
  if (!text) return undefined;
  const links = new Map<string, string>();
  for (const link of [...a.links, ...b.links]) {
    if (!link.label || (links.has(link.label) && links.get(link.label) !== link.url))
      return undefined;
    links.set(link.label, link.url);
  }
  const spans = [...links]
    .map(([label, url]) => ({ label, url, start: text.indexOf(label) }))
    .sort((a, b) => a.start - b.start);
  let at = 0;
  const parts: string[] = [];
  for (const span of spans) {
    if (span.start < at || span.start < 0 || text.indexOf(span.label, span.start + 1) !== -1)
      return undefined;
    parts.push(escapeHtml(text.slice(at, span.start)));
    parts.push(
      `<a href="${escapeHtml(span.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(span.label)}</a>`,
    );
    at = span.start + span.label.length;
  }
  parts.push(escapeHtml(text.slice(at)));
  return parts.join("");
}

/** Deduplicate complete and permanent notices independently, keeping the stricter copy. */
export function projectAttributionPresentations(
  entries: readonly AttributionPresentation[],
): AttributionPresentationGroup {
  const groups: { html: string; members: AttributionPresentation[] }[] = [];
  for (const entry of entries) {
    if (!entry.visibleHtml) continue;
    const group = groups.find(
      (candidate) => mergeVisibleNotice(candidate.html, entry.visibleHtml) !== undefined,
    );
    if (group) {
      group.html = mergeVisibleNotice(group.html, entry.visibleHtml) ?? group.html;
      group.members.push(entry);
    } else groups.push({ html: entry.visibleHtml, members: [entry] });
  }
  return {
    fullHtml: dedupeAttributionHtml(entries.map((entry) => entry.fullHtml)),
    visible: groups.map(({ html, members }) => ({
      html,
      logos: [...new Set(members.flatMap((entry) => entry.logos))],
      ...(members.some((entry) => entry.prominence === "normal")
        ? { prominence: "normal" as const }
        : {}),
    })),
  };
}
