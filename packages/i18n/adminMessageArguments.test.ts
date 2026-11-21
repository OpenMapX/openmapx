import IntlMessageFormat from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { messages } from "./config";

/**
 * Admin messages receive contract codes (statuses, actions, sources) and
 * counts from the API. A code passed as a plain `{status}` argument shows the
 * English code inside a translated sentence, and a count passed as a plain
 * `{count}` is not grouped for the reader's locale. Argument names carry the
 * convention: a code-named argument must be an ICU `select` (its `other`
 * branch may repeat the raw value for codes added later), a count-named
 * argument must be a `number` or `plural`, and an already translated label is
 * passed under a name ending in `Label`.
 */
const CODE_ARGUMENT =
  /^(action|basis|category|change|cleanup|code|direction|kind|level|method|mode|operation|origin|outcome|phase|policy|provenance|readiness|reason|result|severity|source|stage|state|status|type)$/;
const COUNT_ARGUMENT =
  /^(count|total|shown|hidden|added|removed|retained|eligible|quarantined|healthy|enabled|unhealthy|unconfigured|running|stopped|missing|selected|[a-z]+Count|[a-z]+Total)$/;
/** A unit glued to an argument means the number was formatted by hand. */
const HAND_FORMATTED_UNIT = /\}\s?(%|ms\b|s\b)/;

const ADMIN_NAMESPACE = (namespace: string) =>
  namespace.startsWith("admin") || namespace === "privacyAdmin" || namespace === "privacySetup";

const ARGUMENT = 1;
const NUMBER = 2;
const SELECT = 5;
const PLURAL = 6;
const TAG = 8;

interface AstElement {
  type: number;
  value?: string;
  options?: Record<string, { value: AstElement[] }>;
  children?: AstElement[];
}

function argumentProblems(ast: AstElement[], selects: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const element of ast) {
    const name = element.value ?? "";
    if (element.type === ARGUMENT && CODE_ARGUMENT.test(name) && !selects.includes(name))
      problems.push(
        `{${name}} is a code; use {${name}, select, …} or pass a translated ${name}Label`,
      );
    if (element.type === ARGUMENT && COUNT_ARGUMENT.test(name))
      problems.push(`{${name}} is a count; use {${name}, number} or a plural`);
    if (element.type === NUMBER && CODE_ARGUMENT.test(name))
      problems.push(`{${name}} is a code, not a number`);
    if (element.type === SELECT || element.type === PLURAL) {
      const inner = element.type === SELECT ? [...selects, name] : selects;
      for (const option of Object.values(element.options ?? {}))
        problems.push(...argumentProblems(option.value, inner));
    }
    if (element.type === TAG) problems.push(...argumentProblems(element.children ?? [], selects));
  }
  return problems;
}

function adminMessages(locale: keyof typeof messages): [string, string][] {
  const found: [string, string][] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") found.push([path, value]);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  for (const [namespace, value] of Object.entries(messages[locale] as Record<string, unknown>))
    if (ADMIN_NAMESPACE(namespace)) visit(value, namespace);
  return found;
}

describe.each(Object.keys(messages) as (keyof typeof messages)[])(
  "admin messages in %s",
  (locale) => {
    it("pass codes through select", () => {
      const problems = adminMessages(locale).flatMap(([path, text]) =>
        argumentProblems(
          new IntlMessageFormat(text, locale).getAst() as unknown as AstElement[],
        ).map((problem) => `${path}: ${problem}`),
      );
      expect(problems).toEqual([]);
    });

    it("leave units to the locale formatters", () => {
      const handFormatted = adminMessages(locale)
        .filter(([, text]) => HAND_FORMATTED_UNIT.test(text))
        .map(([path, text]) => `${path}: ${text}`);
      expect(handFormatted).toEqual([]);
    });

    it("space the middle-dot separator on both sides", () => {
      const unspaced = adminMessages(locale)
        .filter(([, text]) => /·\S|\S·/.test(text))
        .map(([path, text]) => `${path}: ${text}`);
      expect(unspaced).toEqual([]);
    });
  },
);

describe("admin message argument check", () => {
  const check = (text: string) =>
    argumentProblems(new IntlMessageFormat(text, "en").getAst() as unknown as AstElement[]);

  it("rejects a code passed as a plain argument", () => {
    expect(check("Queued {action}")).toHaveLength(1);
    expect(check("<b>{status}</b>")).toHaveLength(1);
    expect(check("{other, select, a {{state}} other {x}}")).toHaveLength(1);
    expect(check("{count, plural, other {{source}}}")).toHaveLength(1);
  });

  it("rejects a count passed as a plain argument", () => {
    expect(check("{count} total")).toHaveLength(1);
    expect(check("{running} running · {stopped} stopped")).toHaveLength(2);
  });

  it("accepts selects, their raw fallback, numbers, plurals and translated labels", () => {
    expect(check("{action, select, start {Start} other {{action}}} queued")).toEqual([]);
    expect(check("{count, number} total")).toEqual([]);
    expect(check("{count, plural, one {# job} other {# jobs}}")).toEqual([]);
    expect(check("Status: {statusLabel}")).toEqual([]);
  });
});
