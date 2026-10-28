import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test";

const state = vi.hoisted(() => ({ session: { data: null as unknown, isPending: false } }));
vi.mock("@openmapx/core", () => ({ useSession: () => state.session }));

import { MangroveSignerSessionGuard } from "./MangroveSignerSessionGuard";

afterEach(() => sessionStorage.clear());
describe("signer credentials follow exact OpenMapX session", () => {
  it("clears credentials and reconnect draft on same-user session replacement", () => {
    state.session = { data: { user: { id: "a" }, session: { id: "one" } }, isPending: false };
    const { rerender } = render(<MangroveSignerSessionGuard />);
    sessionStorage.setItem("openmapx.mangrove.signer", "sensitive fixture");
    sessionStorage.setItem("openmapx.mangrove.draft", "draft");
    state.session = { data: { user: { id: "a" }, session: { id: "two" } }, isPending: false };
    rerender(<MangroveSignerSessionGuard />);
    expect(sessionStorage.getItem("openmapx.mangrove.signer")).toBeNull();
    expect(sessionStorage.getItem("openmapx.mangrove.draft")).toBeNull();
  });
  it("removes saved bearer material when the tab starts already signed out", () => {
    state.session = { data: null, isPending: false };
    sessionStorage.setItem("openmapx.mangrove.signer", "sensitive fixture");
    render(<MangroveSignerSessionGuard />);
    expect(sessionStorage.getItem("openmapx.mangrove.signer")).toBeNull();
  });
});
