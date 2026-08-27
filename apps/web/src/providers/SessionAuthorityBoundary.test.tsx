import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";
import { act, render, screen } from "@/test";

const sessionState = { current: { data: null as unknown, isPending: false } };
vi.mock("@openmapx/core", () => ({ useSession: () => sessionState.current }));

const { SessionAuthorityBoundary, useSettledSessionAuthority } = await import(
  "./SessionAuthorityBoundary"
);

function signedInSession(userId: string, sessionId: string) {
  return {
    user: { id: userId, name: `User ${userId}`, email: `${userId}@example.test` },
    session: { id: sessionId },
  };
}

function AuthorityConsumer() {
  const { authorityKey, data, isPending } = useSettledSessionAuthority();
  return (
    <div data-testid="authority-consumer">
      {data?.user.id ?? "signed-out"}:{authorityKey ?? "anonymous"}:{String(isPending)}
    </div>
  );
}

afterEach(() => {
  sessionState.current = { data: null, isPending: false };
  act(() => useAccountSettingsStore.getState().close());
});

describe("SessionAuthorityBoundary", () => {
  it("keeps the public tree available while the initial session lookup is pending", () => {
    sessionState.current = { data: null, isPending: true };

    render(
      <SessionAuthorityBoundary>
        <AuthorityConsumer />
      </SessionAuthorityBoundary>,
    );

    expect(screen.getByTestId("authority-consumer")).toHaveTextContent("signed-out:anonymous:true");
  });

  it("exposes the exact user and session authority", () => {
    sessionState.current = { data: signedInSession("user-a", "session-a"), isPending: false };

    render(
      <SessionAuthorityBoundary>
        <AuthorityConsumer />
      </SessionAuthorityBoundary>,
    );

    expect(screen.getByTestId("authority-consumer")).toHaveTextContent(
      'user-a:["user-a","session-a"]:false',
    );
  });

  it("hides a signed-in tree while its session refresh is pending", () => {
    sessionState.current = { data: signedInSession("user-a", "session-a"), isPending: true };

    render(
      <SessionAuthorityBoundary>
        <AuthorityConsumer />
      </SessionAuthorityBoundary>,
    );

    expect(screen.queryByTestId("authority-consumer")).toBeNull();
  });

  it("remounts consumers and closes private UI when authority changes", () => {
    let nextMount = 0;
    function MountTrackedConsumer() {
      const [mount] = useState(() => ++nextMount);
      const { data } = useSettledSessionAuthority();
      return <div data-testid="tracked">{`${data?.user.id}:${mount}`}</div>;
    }

    sessionState.current = { data: signedInSession("user-a", "session-a"), isPending: false };
    const view = render(
      <SessionAuthorityBoundary>
        <MountTrackedConsumer />
      </SessionAuthorityBoundary>,
    );
    expect(screen.getByTestId("tracked")).toHaveTextContent("user-a:1");
    act(() => useAccountSettingsStore.getState().show("timeline"));

    sessionState.current = { data: signedInSession("user-b", "session-b"), isPending: false };
    view.rerender(
      <SessionAuthorityBoundary>
        <MountTrackedConsumer />
      </SessionAuthorityBoundary>,
    );

    expect(screen.getByTestId("tracked")).toHaveTextContent("user-b:2");
    expect(useAccountSettingsStore.getState()).toMatchObject({ open: false, section: null });
  });

  it("fails closed for a malformed signed-in session", () => {
    sessionState.current = {
      data: { user: { id: "user-a" }, session: { id: "" } },
      isPending: false,
    };

    render(
      <SessionAuthorityBoundary>
        <AuthorityConsumer />
      </SessionAuthorityBoundary>,
    );

    expect(screen.queryByTestId("authority-consumer")).toBeNull();
  });
});
