import { fireEvent, render } from "@testing-library/react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { NativeRecoveryOverlay } from "./NativeRecoveryOverlay";
import { SHELL_ACTIONS, type ShellAction, type ShellState } from "./ShellState";

const noop = () => undefined;

async function show(state: ShellState, locale: MobileLocale = "en", onAction = noop) {
  return render(<NativeRecoveryOverlay locale={locale} state={state} onAction={onAction} />);
}

const EXPLAINED: ShellState[] = [
  { kind: "load-error", offline: false },
  { kind: "load-error", offline: true },
  { kind: "offline-navigating" },
  { kind: "incompatible-shell" },
  { kind: "corrupt-session" },
  { kind: "permission-lost" },
  { kind: "resume-offer" },
  { kind: "fatal-config" },
];

describe("NativeRecoveryOverlay", () => {
  it.each([{ kind: "loading" }, { kind: "web" }] as ShellState[])(
    "renders nothing for %p",
    async (state) => {
      expect((await show(state)).toJSON()).toBeNull();
    },
  );

  it.each(EXPLAINED)("renders a titled explanation for %p", async (state) => {
    const view = await show(state);

    expect(view.getByTestId(`shell-state-${state.kind}`)).toBeTruthy();
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered.length).toBeGreaterThan(0);
    // The copy key must resolve; an unresolved key renders as the bare key.
    expect(rendered).not.toContain('"Title"');
  });

  it.each(EXPLAINED)("offers exactly the declared actions for %p", async (state) => {
    const view = await show(state);
    const expected = SHELL_ACTIONS[state.kind];

    const rendered = view.toJSON();
    const ids = JSON.stringify(rendered).match(/shell-action-[a-z-]+/g) ?? [];
    expect(new Set(ids).size).toBe(expected.length);
  });

  it("reports the action the user chose", async () => {
    const onAction = jest.fn();
    const view = await show({ kind: "offline-navigating" }, "en", onAction);

    await fireEvent.press(view.getByTestId("shell-action-end"));

    expect(onAction).toHaveBeenCalledWith("end" satisfies ShellAction);
  });

  it("says that guidance continues when the page cannot load mid-session", async () => {
    const view = await show({ kind: "offline-navigating" });

    expect(JSON.stringify(view.toJSON())).toContain("keeps guiding you");
  });

  it("does not imply guidance is running when no session exists", async () => {
    const view = await show({ kind: "load-error", offline: true });

    expect(JSON.stringify(view.toJSON())).not.toContain("keeps guiding you");
  });

  it("never offers to re-request permission after it was revoked", async () => {
    const view = await show({ kind: "permission-lost" });

    expect(view.queryByTestId("shell-action-retry")).toBeNull();
    expect(view.getByTestId("shell-action-app-settings")).toBeTruthy();
  });

  it("offers nothing at all for a fatally misconfigured build", async () => {
    const view = await show({ kind: "fatal-config" });

    expect(JSON.stringify(view.toJSON())).not.toContain("shell-action-");
  });

  const TEST_ID: Record<ShellAction, string> = {
    retry: "shell-action-retry",
    "open-network-settings": "shell-action-network-settings",
    resume: "shell-action-resume",
    end: "shell-action-end",
    dismiss: "shell-action-dismiss",
    "open-app-settings": "shell-action-app-settings",
  };

  it.each(EXPLAINED)("labels every control for a screen reader in %p", async (state) => {
    const view = await show(state, "de");

    for (const action of SHELL_ACTIONS[state.kind]) {
      const control = view.getByTestId(TEST_ID[action]);
      expect(control.props.accessibilityRole).toBe("button");
      expect(String(control.props.accessibilityLabel ?? "")).not.toHaveLength(0);
    }
  });

  it.each<[MobileLocale, string]>([
    ["en", "Guidance is still running"],
    ["de", "Die Führung läuft weiter"],
  ])("renders %s copy", async (locale, expected) => {
    const view = await show({ kind: "offline-navigating" }, locale);

    expect(JSON.stringify(view.toJSON())).toContain(expected);
  });

  it("renders no map, route or navigation control in any state", async () => {
    for (const state of EXPLAINED) {
      const rendered = JSON.stringify((await show(state)).toJSON());
      for (const forbidden of ["MapView", "route", "maneuver", "recenter", "mute"]) {
        expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});
