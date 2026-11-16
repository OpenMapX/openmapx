import {
  type MobileNavigationSession,
  parseMobileSession,
  type SessionParseResult,
} from "@openmapx/core/navigation";

/**
 * Remembers the validated form of the last stored text that parsed.
 *
 * Navigation reads the active row several times per location fix, and most of
 * those reads see exactly the text the previous one saw. The key is the whole
 * stored text, so a session written by any context, or a different session,
 * always misses; this relies on `parseMobileSession` being a pure function of
 * its input. The store is still read every time — only the schema validation
 * of identical text is skipped.
 *
 * What is remembered is the validated session as JSON text, and a hit decodes
 * it again. Every caller therefore gets its own copy to mutate, exactly as
 * from a fresh parse, and the copy costs one native `JSON.parse` instead of a
 * deep clone in JavaScript. A validated session is plain JSON data, so the
 * round trip loses nothing. Failed parses are never remembered.
 */
export class SessionParseMemo {
  private entry: { text: string; validated: string } | null = null;

  parse(text: string): SessionParseResult {
    if (typeof text !== "string") return parseMobileSession(text);
    if (this.entry?.text === text) {
      return { ok: true, session: JSON.parse(this.entry.validated) as MobileNavigationSession };
    }

    const parsed = parseMobileSession(text);
    if (!parsed.ok) {
      this.clear();
      return parsed;
    }
    this.entry = { text, validated: JSON.stringify(parsed.session) };
    return parsed;
  }

  clear(): void {
    this.entry = null;
  }
}
