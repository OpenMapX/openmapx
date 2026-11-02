// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleHistory } from "@/test/history";
import {
  historyStep,
  type NavigationPath,
  openBackLayer,
  resetBackNavigationForTests,
  subscribeHistoryRestore,
  writeNavigation,
} from "./backNavigation";

/** `?p=a/b` stands in for the open surfaces DeepLinkManager encodes. */
function pathOf(search: string): string[] {
  const panel = new URLSearchParams(search).get("p");
  return panel ? panel.split("/") : [];
}

/** A stand-in app: what it shows follows its own writes and the entries Back lands on. */
let shown: string[] = [];
/** What each restore reported: whether the landed entry changed what is shown. */
let restores: boolean[] = [];

function navigate(url: string): void {
  shown = pathOf(new URL(url, window.location.origin).search);
  writeNavigation(() => ({
    url,
    path: pathOf(new URL(url, window.location.origin).search),
    currentPath: pathOf(window.location.search),
  }));
}

function mountApp(): void {
  subscribeHistoryRestore(() => {
    const target = pathOf(window.location.search);
    const changed = target.join("/") !== shown.join("/");
    shown = target;
    restores.push(changed);
    return changed;
  });
}

function location(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function depth(): number {
  return window.history.state?.omx?.depth ?? 0;
}

async function back(): Promise<void> {
  window.history.back();
  await settleHistory();
}

beforeEach(() => {
  // Something outside the app sits below it, to see a Back leave the app.
  window.history.pushState(null, "", "/elsewhere");
  window.history.pushState(null, "", "/");
  resetBackNavigationForTests();
  shown = [];
  restores = [];
});

afterEach(async () => {
  await settleHistory();
  resetBackNavigationForTests();
});

describe("historyStep", () => {
  const cases: Array<[string, NavigationPath, NavigationPath, string]> = [
    ["unchanged surfaces", ["category:a"], ["category:a"], "replace"],
    ["opening the first surface", [], ["place:x"], "push"],
    ["drilling into a list", ["category:a"], ["category:a", "place:x"], "push"],
    ["closing the innermost surface", ["category:a", "place:x"], ["category:a"], "replace"],
    ["closing everything", ["category:a", "place:x"], [], "replace"],
    [
      "switching to a sibling place",
      ["category:a", "place:x"],
      ["category:a", "place:y"],
      "replace",
    ],
    ["switching category chips", ["category:a"], ["category:b"], "replace"],
    ["opening a different panel", ["category:a", "place:x"], ["saved"], "push"],
    ["starting a tool", ["place:x"], ["place:x", "tool:measure"], "push"],
  ];

  it.each(cases)("%s", (_name, current, next, expected) => {
    expect(historyStep(current, next)).toBe(expected);
  });
});

describe("writeNavigation", () => {
  it("pushes a surface the user opens and lets Back close it", async () => {
    mountApp();
    navigate("/?map=1");
    navigate("/?map=1&p=place:x");
    expect(location()).toBe("/?map=1&p=place:x");
    expect(depth()).toBe(1);

    await back();
    expect(location()).toBe("/?map=1");
    expect(restores).toEqual([true]);
    expect(shown).toEqual([]);
  });

  it("rewrites the current entry for camera changes", () => {
    navigate("/?map=1&p=place:x");
    const length = window.history.length;
    navigate("/?map=2&p=place:x");
    expect(window.history.length).toBe(length);
    expect(location()).toBe("/?map=2&p=place:x");
  });

  it("rewrites the entry when a surface is closed, so Back does not reopen it", async () => {
    mountApp();
    navigate("/?map=1");
    navigate("/?map=1&p=place:x");
    navigate("/?map=1");
    expect(depth()).toBe(1);

    // Nothing is left to close: one Back leaves the app.
    await back();
    expect(location()).toBe("/elsewhere");
  });

  it("reuses a closed surface's entry for the next one instead of stacking", () => {
    navigate("/?map=1");
    navigate("/?map=1&p=place:x");
    navigate("/?map=1");
    navigate("/?map=1&p=place:y");
    expect(depth()).toBe(1);
  });

  it("does not take over an entry an earlier page load wrote", () => {
    window.history.replaceState({ omx: { depth: 1, below: [], doc: "earlier-load" } }, "", "/");
    resetBackNavigationForTests();
    navigate("/?p=place:x");
    expect(depth()).toBe(2);
  });
});

describe("openBackLayer", () => {
  it("lets Back dismiss the layer without leaving the page", async () => {
    mountApp();
    navigate("/?map=1");
    const onBack = vi.fn();
    openBackLayer(onBack);
    expect(depth()).toBe(1);
    expect(location()).toBe("/?map=1");

    await back();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(location()).toBe("/?map=1");
  });

  it("never traverses history when its owner closes it, so a link's navigation survives", async () => {
    navigate("/?map=1");
    const menu = openBackLayer(vi.fn());
    // The menu item closes the menu and the router pushes its page.
    menu.release();
    window.history.pushState(null, "", "/settings/offline");
    await settleHistory();
    expect(location()).toBe("/settings/offline");
  });

  it("makes the Back after a self-closed layer close what lies beneath", async () => {
    mountApp();
    navigate("/?map=1");
    navigate("/?map=1&p=place:x");
    openBackLayer(vi.fn()).release();
    expect(depth()).toBe(2);

    await back();
    expect(shown).toEqual([]);
    expect(location()).toBe("/?map=1");
  });

  it("reuses a closed layer's entry for the next layer", () => {
    openBackLayer(vi.fn()).release();
    openBackLayer(vi.fn());
    expect(depth()).toBe(1);
  });

  it("steps over a closed layer's entry when coming back from another page", async () => {
    mountApp();
    navigate("/?map=1");
    const menu = openBackLayer(vi.fn());
    window.history.pushState(null, "", "/settings");
    menu.release();

    await back();
    expect(location()).toBe("/?map=1");
    expect(depth()).toBe(0);
  });

  it("closes layers a Back jumped over together with the navigation", async () => {
    navigate("/?map=1");
    const lower = vi.fn();
    const upper = vi.fn();
    openBackLayer(lower);
    openBackLayer(upper);
    window.history.go(-2);
    await settleHistory();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it("puts a surface opened while a layer is live above it", async () => {
    mountApp();
    navigate("/?map=1");
    const onBack = vi.fn();
    openBackLayer(onBack);
    navigate("/?map=1&p=place:x");
    expect(depth()).toBe(2);

    await back();
    expect(shown).toEqual([]);
    expect(onBack).not.toHaveBeenCalled();
    await back();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
