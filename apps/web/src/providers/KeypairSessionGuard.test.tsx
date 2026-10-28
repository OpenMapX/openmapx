import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient, render } from "@/test";

const session = { current: { authorityKey: null as string | null } };
vi.mock("./SessionAuthorityBoundary", () => ({
  useSettledSessionAuthority: () => session.current,
}));
const bindOwner = vi.fn();
vi.mock("@openmapx/mangrove-react", () => ({
  useKeypairStore: { getState: () => ({ bindOwner }) },
  MANGROVE_KEYPAIR_QUERY_KEY: ["mangroveKeypairState"],
}));

import { KeypairSessionGuard } from "./KeypairSessionGuard";

afterEach(() => {
  vi.clearAllMocks();
  session.current = { authorityKey: null };
});
describe("KeypairSessionGuard", () => {
  it("binds exact settled session and invalidates the previous session of the same user", () => {
    const client = createTestQueryClient();
    const remove = vi.spyOn(client, "removeQueries");
    session.current = { authorityKey: JSON.stringify(["u1", "s1"]) };
    const { rerender, unmount } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });
    expect(bindOwner).toHaveBeenLastCalledWith(JSON.stringify(["u1", "s1"]));
    session.current = { authorityKey: JSON.stringify(["u1", "s2"]) };
    rerender(<KeypairSessionGuard />);
    expect(bindOwner).toHaveBeenCalledWith(null);
    expect(bindOwner).toHaveBeenLastCalledWith(JSON.stringify(["u1", "s2"]));
    expect(remove).toHaveBeenCalledWith({ queryKey: ["mangroveKeypairState"] });
    unmount();
    expect(bindOwner).toHaveBeenLastCalledWith(null);
  });
  it("revokes authority on logout and unmount", () => {
    session.current = { authorityKey: JSON.stringify(["u1", "s1"]) };
    const { rerender, unmount } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(createTestQueryClient()),
    });
    session.current = { authorityKey: null };
    rerender(<KeypairSessionGuard />);
    expect(bindOwner).toHaveBeenLastCalledWith(null);
    unmount();
    expect(bindOwner).toHaveBeenLastCalledWith(null);
  });
  it("does not tear down a stable authority", () => {
    session.current = { authorityKey: JSON.stringify(["u1", "s1"]) };
    const { rerender } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(createTestQueryClient()),
    });
    bindOwner.mockClear();
    rerender(<KeypairSessionGuard />);
    expect(bindOwner).not.toHaveBeenCalled();
  });
});
