import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test";

const state = vi.hoisted(() => ({ session: { data: null as unknown, isPending: false } }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => state.session,
}));

import { MangroveSignerSessionGuard } from "./MangroveSignerSessionGuard";

const SIGNER_SESSION = "openmapx:mangrove:signer-session";
const REVIEW_DRAFT = "openmapx:reviews:draft";

afterEach(() => sessionStorage.clear());
describe("signer credentials follow exact OpenMapX session", () => {
  it("clears credentials and reconnect draft on same-user session replacement", () => {
    state.session = { data: { user: { id: "a" }, session: { id: "one" } }, isPending: false };
    const { rerender } = render(<MangroveSignerSessionGuard />);
    sessionStorage.setItem(SIGNER_SESSION, "sensitive fixture");
    sessionStorage.setItem(REVIEW_DRAFT, "draft");
    state.session = { data: { user: { id: "a" }, session: { id: "two" } }, isPending: false };
    rerender(<MangroveSignerSessionGuard />);
    expect(sessionStorage.getItem(SIGNER_SESSION)).toBeNull();
    expect(sessionStorage.getItem(REVIEW_DRAFT)).toBeNull();
  });
  it("removes saved bearer material when the tab starts already signed out", () => {
    state.session = { data: null, isPending: false };
    sessionStorage.setItem(SIGNER_SESSION, "sensitive fixture");
    render(<MangroveSignerSessionGuard />);
    expect(sessionStorage.getItem(SIGNER_SESSION)).toBeNull();
  });
  it("keeps state that survives sign-out", () => {
    state.session = { data: null, isPending: false };
    sessionStorage.setItem("openmapx:privacy:pending-export", "pending");
    render(<MangroveSignerSessionGuard />);
    expect(sessionStorage.getItem("openmapx:privacy:pending-export")).toBe("pending");
  });
});
