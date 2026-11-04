import { act, renderHook } from "@testing-library/react-native";
import { Linking } from "react-native";
import { useIncomingLinks } from "./useIncomingLinks";

const config = { webOrigin: "https://openmapx.com", scheme: "openmapx" };

it("keeps the newest event over a delayed initial URL, and allows repeated warm requests", async () => {
  let resolveInitial!: (url: string) => void;
  let receive!: (event: { url: string }) => void;
  const remove = jest.fn();
  jest.spyOn(Linking, "getInitialURL").mockReturnValue(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  jest.spyOn(Linking, "addEventListener").mockImplementation((_type, listener) => {
    receive = listener;
    return { remove } as unknown as ReturnType<typeof Linking.addEventListener>;
  });
  const deliver = jest.fn();
  const hook = await renderHook(() => useIncomingLinks(config, deliver));
  await act(async () => {
    receive({ url: "geo:1,2?q=new" });
    resolveInitial("geo:1,2?q=old");
  });
  expect(deliver).not.toHaveBeenCalled();
  hook.result.current.bridgeReady();
  expect(deliver).toHaveBeenLastCalledWith({ kind: "map", query: "?q=new" });
  receive({ url: "geo:1,2?q=new" });
  expect(deliver).toHaveBeenCalledTimes(2);
  hook.result.current.documentStarted();
  receive({ url: "geo:1,2?q=reload" });
  hook.result.current.documentStarted();
  expect(deliver).toHaveBeenCalledTimes(2);
  hook.result.current.bridgeReady();
  expect(deliver).toHaveBeenLastCalledWith({ kind: "map", query: "?q=reload" });
  await hook.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

it("ignores an initial URL that resolves after unmount", async () => {
  let resolveInitial!: (url: string) => void;
  jest.spyOn(Linking, "getInitialURL").mockReturnValue(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  const deliver = jest.fn();
  const hook = await renderHook(() => useIncomingLinks(config, deliver));
  hook.result.current.bridgeReady();
  await hook.unmount();
  await act(async () => resolveInitial("geo:1,2"));
  expect(deliver).not.toHaveBeenCalled();
});
