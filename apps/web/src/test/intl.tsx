import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

// NOTE: this module must NOT statically import "next-intl". The standard mock
// route is `vi.mock("next-intl", async () => (await import("@/test/intl"))...)`;
// a top-level `import ... from "next-intl"` here makes that mock factory depend
// on the very module it is replacing, which deadlocks Vitest's module resolver
// (the test process hangs forever before any test runs). `renderWithIntl`
// imports the real provider lazily instead.

/**
 * One next-intl module mock to replace the ~11 inline, drifting `useTranslations`
 * mocks across web tests. `t(key)` returns the key (namespaced when a namespace
 * was passed), so assertions read against stable keys instead of copies of the
 * message catalog.
 *
 * Because `vi.mock` factories are hoisted above imports, use the async form:
 *
 *   vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
 *
 * Pass `overrides` to replace specific exports for a given test.
 */
export function mockNextIntl(overrides: Record<string, unknown> = {}) {
  const useTranslations = (namespace?: string) => {
    const key = (k: string) => (namespace ? `${namespace}.${k}` : k);
    const t = (k: string) => key(k);
    t.rich = (k: string) => key(k);
    t.markup = (k: string) => key(k);
    t.raw = (k: string) => key(k);
    t.has = () => true;
    return t;
  };
  return {
    useTranslations,
    useLocale: () => "en",
    useTimeZone: () => "UTC",
    useNow: () => new Date(0),
    useMessages: () => ({}),
    useFormatter: () => ({
      dateTime: (value: Date) => String(value),
      number: (value: number) => String(value),
      relativeTime: (value: Date) => String(value),
      list: (value: Iterable<string>) => [...value].join(", "),
    }),
    NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
    ...overrides,
  };
}

/**
 * Render with a real NextIntlClientProvider (for tests that want actual
 * formatting against a supplied `messages` catalog). Most unit tests should
 * prefer {@link mockNextIntl}; reach for this only when real ICU formatting is
 * under test.
 *
 * Async because `next-intl` is imported lazily here (it must not be a top-level
 * import of this module — see the note above). Await the result before
 * asserting: `const { getByText } = await renderWithIntl(<C />, { messages });`.
 */
export async function renderWithIntl(
  ui: ReactElement,
  { locale = "en", messages = {} }: { locale?: string; messages?: Record<string, unknown> } = {},
) {
  const { NextIntlClientProvider } = await import("next-intl");
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}
