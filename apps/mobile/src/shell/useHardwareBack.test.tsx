import { renderHook } from "@testing-library/react-native";
import { BackHandler } from "react-native";
import type { WebView } from "react-native-webview";
import { useHardwareBack } from "./useHardwareBack";

function setup() {
  let press: (() => boolean | null | undefined) | undefined;
  const remove = jest.fn();
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
    press = () => handler({} as never);
    return { remove };
  });
  const goBack = jest.fn();
  const webViewRef = { current: { goBack } as unknown as WebView };
  return { press: () => press?.(), remove, goBack, webViewRef };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useHardwareBack", () => {
  it("leaves Back to the system while the page has no history", async () => {
    const { press, goBack, webViewRef } = setup();
    await renderHook(() => useHardwareBack(webViewRef));
    expect(press()).toBe(false);
    expect(goBack).not.toHaveBeenCalled();
  });

  it("steps back through the page's history once it has some", async () => {
    const { press, goBack, webViewRef } = setup();
    const { result } = await renderHook(() => useHardwareBack(webViewRef));
    result.current({ canGoBack: true });
    expect(press()).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);

    result.current({ canGoBack: false });
    expect(press()).toBe(false);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the shell unmounts", async () => {
    const { remove, webViewRef } = setup();
    const { unmount } = await renderHook(() => useHardwareBack(webViewRef));
    await unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
