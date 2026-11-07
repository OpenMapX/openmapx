import { afterEach, describe, expect, it } from "vitest";
import { lockedViewportContent, lockShellViewport } from "./shellViewport";

const LOCKED = "initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no";

function viewport(): string | null {
  return document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;
}

function setViewport(content: string) {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "viewport");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}

/** MutationObserver callbacks run as microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lockedViewportContent", () => {
  it("keeps the page's other keys and fixes the scale", () => {
    expect(
      lockedViewportContent(
        "width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover",
      ),
    ).toBe(`width=device-width,viewport-fit=cover,${LOCKED}`);
  });

  it("falls back to the device width when nothing else is declared", () => {
    expect(lockedViewportContent(null)).toBe(`width=device-width,${LOCKED}`);
  });
});

describe("lockShellViewport", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    document.head.innerHTML = "";
  });

  it("locks the existing viewport tag", () => {
    setViewport("width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover");
    stop = lockShellViewport(document);
    expect(viewport()).toBe(`width=device-width,viewport-fit=cover,${LOCKED}`);
  });

  it("adds a viewport tag when the page has none", () => {
    stop = lockShellViewport(document);
    expect(viewport()).toBe(`width=device-width,${LOCKED}`);
  });

  it("restores the lock when the tag is rewritten", async () => {
    setViewport("width=device-width");
    stop = lockShellViewport(document);
    setViewport("width=device-width, maximum-scale=5");
    await flush();
    expect(viewport()).toBe(`width=device-width,${LOCKED}`);
  });

  it("restores the lock when the tag is replaced", async () => {
    setViewport("width=device-width");
    stop = lockShellViewport(document);
    document.head.innerHTML =
      '<meta name="viewport" content="width=device-width, maximum-scale=5">';
    await flush();
    expect(viewport()).toBe(`width=device-width,${LOCKED}`);
  });

  it("stops watching once released", async () => {
    setViewport("width=device-width");
    stop = lockShellViewport(document);
    stop();
    setViewport("width=device-width, maximum-scale=5");
    await flush();
    expect(viewport()).toBe("width=device-width, maximum-scale=5");
  });
});
