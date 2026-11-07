import { runInNewContext } from "node:vm";
import { VIEWPORT_LOCK_SCRIPT } from "./viewportScript";

/** Just enough of a document for the viewport program: one head and its meta tags. */
function fakePage(initialContent: string | null) {
  const attrs = new Map<string, string>();
  let meta: {
    getAttribute(n: string): string | null;
    setAttribute(n: string, v: string): void;
  } | null = null;
  const makeMeta = () => ({
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => {
      attrs.set(n, v);
      observer?.();
    },
  });
  if (initialContent !== null) {
    attrs.set("name", "viewport");
    attrs.set("content", initialContent);
    meta = makeMeta();
  }
  let observer: (() => void) | undefined;
  const head = {
    appendChild: (node: typeof meta) => {
      meta = node;
    },
  };
  const window = {
    document: {
      head,
      documentElement: head,
      querySelector: () => meta,
      createElement: () => makeMeta(),
    },
    MutationObserver: class {
      constructor(cb: () => void) {
        observer = cb;
      }
      observe() {}
    },
  };
  return {
    window,
    content: () => attrs.get("content"),
    pageRewrites: (value: string) => meta?.setAttribute("content", value),
  };
}

describe("viewport lock script", () => {
  it("keeps the page's other viewport keys and fixes the scale", () => {
    const page = fakePage(
      "width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover",
    );
    expect(runInNewContext(VIEWPORT_LOCK_SCRIPT, page.window)).toBe(true);
    expect(page.content()).toBe(
      "width=device-width,viewport-fit=cover,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no",
    );
  });

  it("adds a viewport tag when the page has none", () => {
    const page = fakePage(null);
    runInNewContext(VIEWPORT_LOCK_SCRIPT, page.window);
    expect(page.content()).toBe(
      "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no",
    );
  });

  it("restores the lock when the page rewrites the tag", () => {
    const page = fakePage("width=device-width");
    runInNewContext(VIEWPORT_LOCK_SCRIPT, page.window);
    page.pageRewrites("width=device-width, maximum-scale=5");
    expect(page.content()).toBe(
      "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no",
    );
  });

  it("publishes nothing on the page's window", () => {
    const page = fakePage("width=device-width");
    const before = Object.keys(page.window);
    runInNewContext(VIEWPORT_LOCK_SCRIPT, page.window);
    expect(Object.keys(page.window)).toEqual(before);
  });
});
