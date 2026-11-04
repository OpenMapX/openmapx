import { useSearchStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DEEPLINK_OPEN_EVENT } from "@/lib/deepLink";
import { ShareIntentHandler } from "./ShareIntentHandler";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  useSearchStore.getState().setQuery("");
});
it("consumes native warm search requests and repeated identical requests", () => {
  const view = render(<ShareIntentHandler />);
  for (let i = 0; i < 2; i++) {
    useSearchStore.getState().setQuery("");
    act(() => {
      window.history.replaceState(null, "", "/?q=Main+Street&map=1,2,13,0,0");
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
    expect(useSearchStore.getState().query).toBe("Main Street");
    expect(window.location.search).toBe("?map=1%2C2%2C13%2C0%2C0");
  }
  view.unmount();
  window.history.replaceState(null, "", "/?q=ignored");
  window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
  expect(window.location.search).toBe("?q=ignored");
});
it("still consumes cold PWA geo requests while preserving unrelated state", () => {
  window.history.replaceState(null, "", "/?geo=geo%3A0%2C0%3Fq%3DMunich&panel=saved#anchor");
  render(<ShareIntentHandler />);
  expect(useSearchStore.getState().query).toBe("Munich");
  expect(window.location.search).toBe("?panel=saved");
  expect(window.location.hash).toBe("#anchor");
});
