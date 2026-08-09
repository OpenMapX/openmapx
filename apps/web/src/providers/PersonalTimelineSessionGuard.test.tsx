import { PERSONAL_TIMELINE_QUERY_KEY, usePersonalTimelineStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient, render } from "@/test";

const session = { current: { data: null as unknown, isPending: false } };
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, useSession: () => session.current };
});

import { PersonalTimelineSessionGuard } from "./PersonalTimelineSessionGuard";

afterEach(() => {
  session.current = { data: null, isPending: false };
  usePersonalTimelineStore.getState().resetForSession();
});

function seedPrivateState() {
  const client = createTestQueryClient();
  client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "connection"], {
    connected: true,
  });
  client.setQueryData([...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "day", "2026-08-09"], {
    entries: [{ id: "private-a" }],
  });
  usePersonalTimelineStore.getState().setSelectedDate("2026-08-09");
  usePersonalTimelineStore.getState().selectEntry("private-a");
  return client;
}

describe("PersonalTimelineSessionGuard", () => {
  it("purges all timeline cache and UI state on logout", () => {
    const client = seedPrivateState();
    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    const { rerender } = render(<PersonalTimelineSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    session.current = { data: null, isPending: false };
    rerender(<PersonalTimelineSessionGuard />);

    expect(client.getQueriesData({ queryKey: PERSONAL_TIMELINE_QUERY_KEY })).toEqual([]);
    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: null,
      selectedEntryId: null,
    });
  });

  it.each(["ordinary account switch", "impersonation identity replacement"])(
    "purges all timeline data on %s",
    () => {
      const client = seedPrivateState();
      session.current = { data: { user: { id: "user-a" } }, isPending: false };
      const { rerender } = render(<PersonalTimelineSessionGuard />, {
        wrapper: createQueryWrapper(client),
      });

      session.current = { data: { user: { id: "user-b" } }, isPending: false };
      rerender(<PersonalTimelineSessionGuard />);

      expect(client.getQueriesData({ queryKey: PERSONAL_TIMELINE_QUERY_KEY })).toEqual([]);
      expect(usePersonalTimelineStore.getState()).toMatchObject({
        selectedDate: null,
        selectedEntryId: null,
      });
    },
  );

  it("does not purge a same-user rerender", () => {
    const client = seedPrivateState();
    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    const { rerender } = render(<PersonalTimelineSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    rerender(<PersonalTimelineSessionGuard />);

    expect(client.getQueriesData({ queryKey: PERSONAL_TIMELINE_QUERY_KEY })).toHaveLength(2);
    expect(usePersonalTimelineStore.getState().selectedEntryId).toBe("private-a");
  });

  it("waits through initial pending and preserves the resolved user's first data", () => {
    const client = seedPrivateState();
    session.current = { data: null, isPending: true };
    const { rerender } = render(<PersonalTimelineSessionGuard />, {
      wrapper: createQueryWrapper(client),
    });

    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    rerender(<PersonalTimelineSessionGuard />);

    expect(client.getQueriesData({ queryKey: PERSONAL_TIMELINE_QUERY_KEY })).toHaveLength(2);
    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: "2026-08-09",
      selectedEntryId: "private-a",
    });
  });

  it("does not purge on an initially settled login", () => {
    const client = seedPrivateState();
    session.current = { data: { user: { id: "user-a" } }, isPending: false };

    render(<PersonalTimelineSessionGuard />, { wrapper: createQueryWrapper(client) });

    expect(client.getQueriesData({ queryKey: PERSONAL_TIMELINE_QUERY_KEY })).toHaveLength(2);
  });
});
