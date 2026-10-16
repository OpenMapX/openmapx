import escapeHtml from "escape-html";
import {
  type AttributionDetail,
  type AttributionPresentation,
  parseAttributionHtml,
} from "./attribution";

/** Whole credited fragment, never a prefix of another publisher's name. */
function containsNoticeText(candidate: string, notice: string): boolean {
  if (!notice) return false;
  let start = candidate.indexOf(notice);
  while (start !== -1) {
    const before = candidate.slice(0, start).trimEnd();
    const tail = candidate.slice(start + notice.length);
    const after = tail.trimStart();
    if (
      (!before ||
        notice.startsWith("©") ||
        before.endsWith("©") ||
        before.endsWith("|") ||
        before.endsWith("·")) &&
      (!after ||
        after.startsWith("(") ||
        after.startsWith("|") ||
        after.startsWith("·") ||
        // Only the builder's spaced appendix delimiter, never a name suffix.
        tail.startsWith(" — "))
    )
      return true;
    start = candidate.indexOf(notice, start + 1);
  }
  return false;
}

type ParsedNotice = ReturnType<typeof parseAttributionHtml> & { html: string };

/** A projection owns its cache; no notice or mutable receipt survives the call. */
function noticeReader(): (html: string) => ParsedNotice {
  const parsed = new Map<string, ParsedNotice>();
  return (html) => {
    let notice = parsed.get(html);
    if (!notice) {
      notice = { html, ...parseAttributionHtml(html) };
      parsed.set(html, notice);
    }
    return notice;
  };
}

/**
 * Compare complete credited fragments and parsed notices: a linked
 * basemap notice can cover an overlay's plain copy of the same wording. Only
 * discard that copy if the retained notice preserves every link, including
 * its label and target. Equal link sets keep the first occurrence; distinct or
 * complementary licence/publisher links remain separate.
 */
export function dedupeAttributionHtml(items: string[]): string[] {
  return dedupeNotices(items.map(noticeReader()));
}

function dedupeNotices(notices: readonly ParsedNotice[]): string[] {
  type Notice = ParsedNotice;
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
  details: AttributionDetail[];
  visible: VisibleAttribution[];
}

/** Keep the longer wording and every link, only when link spans are unambiguous. */
function mergeVisibleNotice(a: ParsedNotice, b: ParsedNotice): string | undefined {
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

/** Group a source's grants without flattening its distinct notices or source links. */
export function mergeAttributionDetails(
  entries: readonly AttributionDetail[],
): AttributionDetail[] {
  const groups = new Map<string, AttributionDetail[]>();
  for (const entry of entries) {
    const attr = entry.attribution;
    const { sourceId: _sourceId, licensing: _licensing, ...identity } = attr ?? {};
    const key = attr ? JSON.stringify(identity) : entry.html;
    const bucket = groups.get(key) ?? [];
    const previous = bucket.at(-1);
    if (!previous?.attribution || !attr) {
      groups.set(key, [structuredClone(entry)]);
      continue;
    }
    const distinct = <T>(items: readonly T[]): T[] => [
      ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
    ];
    const bindings = distinct([
      ...(previous.attribution.licensing?.bindings ?? []),
      ...(attr.licensing?.bindings ?? []),
    ]);
    const declarations = distinct([
      ...(previous.attribution.licensing?.declarations ?? []),
      ...(attr.licensing?.declarations ?? []),
    ]);
    // The portable contract bounds each array. Keep another complete source
    // snapshot instead of creating an invalid aggregate that renderers reject.
    if (bindings.length > 64 || declarations.length > 64) {
      bucket.push(structuredClone(entry));
      continue;
    }
    if (bindings.length || declarations.length)
      previous.attribution.licensing = {
        version: 1,
        bindings,
        declarations,
      };
    previous.links = distinct([...(previous.links ?? []), ...(entry.links ?? [])]);
  }
  return [...groups.values()].flat();
}

/** Deduplicate complete and permanent notices independently, keeping the stricter copy. */
export function projectAttributionPresentations(
  entries: readonly AttributionPresentation[],
): AttributionPresentationGroup {
  const readNotice = noticeReader();
  const groups: { notice: ParsedNotice; members: AttributionPresentation[] }[] = [];
  for (const entry of entries) {
    if (!entry.visibleHtml) continue;
    const notice = readNotice(entry.visibleHtml);
    let merged = false;
    for (const group of groups) {
      const combined = mergeVisibleNotice(group.notice, notice);
      if (!combined) continue;
      // Parse each distinct generated fragment once too, preserving HTML
      // normalization before its text and links participate in later merges.
      group.notice = readNotice(combined);
      group.members.push(entry);
      merged = true;
      break;
    }
    if (!merged) groups.push({ notice, members: [entry] });
  }
  const fullHtml = dedupeNotices(entries.map((entry) => readNotice(entry.fullHtml)));
  return {
    fullHtml,
    details: mergeAttributionDetails(
      entries
        .filter((entry) => entry.fullHtml)
        .map((entry) => ({ html: entry.fullHtml, attribution: entry.detail })),
    ),
    visible: groups.map(({ notice, members }) => ({
      html: notice.html,
      logos: [...new Set(members.flatMap((entry) => entry.logos))],
      ...(members.some((entry) => entry.prominence === "normal")
        ? { prominence: "normal" as const }
        : {}),
    })),
  };
}
