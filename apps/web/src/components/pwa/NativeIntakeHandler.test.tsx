import { useImportedGeometryStore, useNavigationStore } from "@openmapx/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { NativeIntakeHandler } from "./NativeIntakeHandler";

const f = vi.hoisted(() => ({
  list: vi.fn(),
  text: vi.fn(),
  complete: vi.fn(),
  mutating: false,
  pathname: "/",
  push: vi.fn(),
}));
const item = {
  id: "f386e706-b728-40a3-9554-881d0ff0958a",
  kind: "file",
  format: "geojson",
  name: "walk.geojson",
  byteLength: 50,
  createdAtMs: 1,
};
vi.mock("next/navigation", () => ({
  usePathname: () => f.pathname,
  useRouter: () => ({ push: f.push }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/mobile/nativeIntake", () => ({
  NativeIntakeClient: class {
    list = f.list;
    text = f.text;
    complete = f.complete;
  },
}));
const client = { subscribe: () => () => undefined };
const commands = {
  get isMutating() {
    return f.mutating;
  },
};
vi.mock("@/lib/mobile/MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => ({
    state: "native-compatible",
    handshake: { selectedProtocolVersion: 4, capabilities: { nativeIntake: true } },
    client,
    commands,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  f.mutating = false;
  f.pathname = "/";
  useNavigationStore.setState({ status: "idle", nativeSessionId: null });
  useImportedGeometryStore.getState().clearImported();
  f.list.mockResolvedValue({ items: [item], canApply: true, scheme: "openmapx" });
  f.text.mockResolvedValue('{"type":"Point","coordinates":[8,50]}');
  f.complete.mockResolvedValue(undefined);
});
it("previews without applying, Later retains content", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  fireEvent.click(screen.getByText("later"));
  expect(f.complete).not.toHaveBeenCalled();
});
it("imports only on confirmation and acknowledges the exact item", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockResolvedValue({ items: [item], canApply: true, scheme: "openmapx" });
  fireEvent.click(screen.getByText("import"));
  await waitFor(() => expect(f.complete).toHaveBeenCalledWith(item.id, "opened"));
  expect(useImportedGeometryStore.getState().imported?.name).toBe("walk.geojson");
});
it("defers a navigation-start race without applying or deleting", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockImplementation(async () => {
    f.mutating = true;
    return { items: [item], canApply: true, scheme: "openmapx" };
  });
  fireEvent.click(screen.getByText("import"));
  await screen.findByText("deferred");
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});
it("does not auto-open or consume while native reports an active trip", async () => {
  f.list.mockResolvedValue({ items: [item], canApply: false, scheme: "openmapx" });
  render(<NativeIntakeHandler />);
  await screen.findByText("pending");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.text).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
});

it("offers a route back to the map before previewing content on settings pages", async () => {
  f.pathname = "/settings";
  render(<NativeIntakeHandler />);
  await screen.findByText("pending");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.text).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("pending"));
  expect(f.push).toHaveBeenCalledWith("/");
  expect(f.complete).not.toHaveBeenCalled();
});
