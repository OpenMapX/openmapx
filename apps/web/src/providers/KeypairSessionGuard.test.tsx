import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient, render } from "@/test";

const session = { current: { data: null as unknown, isPending: false } };
vi.mock("@openmapx/core", () => ({ useSession: () => session.current }));

const clear = vi.fn();
vi.mock("@openmapx/mangrove-react", () => ({
  useKeypairStore: { getState: () => ({ clear }) },
  MANGROVE_KEYPAIR_QUERY_KEY: ["mangroveKeypairState"],
}));

import { KeypairSessionGuard } from "./KeypairSessionGuard";

afterEach(() => {
  vi.clearAllMocks();
  session.current = { data: null, isPending: false };
});

describe("KeypairSessionGuard", () => {
  function createClientWithRemoveQueriesMock() {
    const client = createTestQueryClient();
    const removeQueries = vi.fn() as typeof client.removeQueries;
    client.removeQueries = removeQueries;
    return { client, removeQueries };
  }

  it("evicts the envelope on a sign-out transition", () => {
    const { client, removeQueries } = createClientWithRemoveQueriesMock();
    session.current = { data: { user: { id: "u1" } }, isPending: false };
    const { rerender } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    session.current = { data: null, isPending: false };
    rerender(<KeypairSessionGuard />);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ["mangroveKeypairState"] });
  });

  it("evicts the envelope on a user switch", () => {
    const { client, removeQueries } = createClientWithRemoveQueriesMock();
    session.current = { data: { user: { id: "u1" } }, isPending: false };
    const { rerender } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    session.current = { data: { user: { id: "u2" } }, isPending: false };
    rerender(<KeypairSessionGuard />);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ["mangroveKeypairState"] });
  });

  it("does not evict the envelope for a stable session", () => {
    const { client, removeQueries } = createClientWithRemoveQueriesMock();
    session.current = { data: { user: { id: "u1" } }, isPending: false };
    const { rerender } = render(<KeypairSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    rerender(<KeypairSessionGuard />);

    expect(clear).not.toHaveBeenCalled();
    expect(removeQueries).not.toHaveBeenCalled();
  });

  it("does not evict the envelope while the session is pending", () => {
    const { client, removeQueries } = createClientWithRemoveQueriesMock();
    session.current = { data: { user: { id: "u1" } }, isPending: true };
    render(<KeypairSessionGuard />, { wrapper: createQueryWrapper(client) });

    expect(clear).not.toHaveBeenCalled();
    expect(removeQueries).not.toHaveBeenCalled();
  });
});
