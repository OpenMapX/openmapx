import { useNavigationStore } from "@openmapx/core";
import { expect, it } from "vitest";
import { applyNativeSurfaceStop } from "./nativeSurfaceStop";

it("resets only the named native session and preserves native authority", () => {
  useNavigationStore.setState({
    nativeSessionId: "B",
    navigationAuthority: "native",
    nativeRevision: 3,
  });
  expect(applyNativeSurfaceStop("A")).toBe(false);
  expect(useNavigationStore.getState().nativeSessionId).toBe("B");
  expect(applyNativeSurfaceStop("B")).toBe(true);
  expect(useNavigationStore.getState().nativeSessionId).toBeNull();
  expect(useNavigationStore.getState().navigationAuthority).toBe("native");
  expect(useNavigationStore.getState().status).toBe("idle");
});
