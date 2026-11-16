import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const dialogProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: (props: Record<string, unknown>) => {
    dialogProps.push(props);
    return <div role="dialog">{String(props.notice)}</div>;
  },
}));

const assign = vi.fn();

beforeEach(() => {
  dialogProps.length = 0;
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign, search: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderWithReturn(value: string | null) {
  const search = value === null ? "" : `?${new URLSearchParams({ return: value })}`;
  vi.stubGlobal("location", { ...window.location, assign, search });
  const { default: Page } = await import("./page");
  render(<Page />);
  return dialogProps[dialogProps.length - 1];
}

describe("confirm sign-in page", () => {
  it("asks for a sign-in that cannot be dismissed and explains why", async () => {
    const props = await renderWithReturn("/delete-account");
    expect(screen.getByRole("dialog").textContent).toBe("account.freshSignIn.notice");
    expect(props.open).toBe(true);
    expect(props.dismissible).toBe(false);
  });

  it("returns to the same-site page it was sent from", async () => {
    const props = await renderWithReturn("/?place=osm%3Anode%3A12");
    expect(props.callbackPath).toBe("/?place=osm%3Anode%3A12");
    (props.onClose as () => void)();
    expect(assign).toHaveBeenCalledWith("/?place=osm%3Anode%3A12");
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"])(
    "never returns to %s",
    async (value) => {
      const props = await renderWithReturn(value);
      expect(props.callbackPath).toBe("/");
      (props.onClose as () => void)();
      expect(assign).toHaveBeenCalledWith("/");
    },
  );

  it("falls back to / without a return path", async () => {
    const props = await renderWithReturn(null);
    expect(props.callbackPath).toBe("/");
  });
});
