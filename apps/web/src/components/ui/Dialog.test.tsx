// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBackNavigationForTests } from "@/lib/backNavigation";
import { settleHistory } from "@/test/history";
import Dialog from "./Dialog";

function depth(): number {
  return window.history.state?.omx?.depth ?? 0;
}

async function settled(): Promise<void> {
  await act(settleHistory);
}

function Harness({ onClose }: { onClose?: (reason: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(false)}>
        done
      </button>
      <Dialog
        open={open}
        onClose={(_event, reason) => {
          onClose?.(reason);
          setOpen(false);
        }}
      >
        <p>content</p>
      </Dialog>
    </>
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  resetBackNavigationForTests();
});

describe("Dialog", () => {
  it("closes on Back the way Escape closes it", async () => {
    const onClose = vi.fn();
    const view = render(<Harness onClose={onClose} />);
    expect(depth()).toBe(1);

    await act(async () => {
      window.history.back();
    });
    await settled();

    expect(onClose).toHaveBeenCalledWith("escapeKeyDown");
    await waitFor(() => expect(view.queryByText("content")).toBeNull());
    expect(depth()).toBe(0);
  });

  it("leaves history alone when closed by its own controls, and the next Back steps past it", async () => {
    window.history.pushState(null, "", "/elsewhere");
    window.history.pushState(null, "", "/");
    resetBackNavigationForTests();
    const view = render(<Harness />);
    expect(depth()).toBe(1);

    act(() => view.getByText("done").click());
    await settled();
    // No traversal of its own: one could cancel a page navigation in flight.
    expect(depth()).toBe(1);

    window.history.back();
    await settled();
    expect(window.location.pathname).toBe("/elsewhere");
  });

  it("adds no entry for a dialog nobody can close", () => {
    render(
      <Dialog open>
        <p>content</p>
      </Dialog>,
    );
    expect(depth()).toBe(0);
  });
});
