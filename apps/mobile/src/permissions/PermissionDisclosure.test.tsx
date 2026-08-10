import { fireEvent, render } from "@testing-library/react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { PermissionDisclosure, PermissionOutcome } from "./PermissionDisclosure";
import type { PermissionFlowState } from "./permissionMachine";

const noop = () => undefined;

async function renderDisclosure(locale: MobileLocale, handlers = {}) {
  return render(
    <PermissionDisclosure
      locale={locale}
      onAccept={noop}
      onForegroundOnly={noop}
      onDismiss={noop}
      {...handlers}
    />,
  );
}

/** Everything the screen renders, so a claim can be checked against all of it. */
function allText(view: Awaited<ReturnType<typeof renderDisclosure>>): string {
  return view.root ? JSON.stringify(view.toJSON()) : "";
}

describe("PermissionDisclosure", () => {
  it.each<[MobileLocale, string[]]>([
    [
      "en",
      [
        "precise location",
        "screen is locked",
        "on this device",
        "not stored as a location history",
        "Coordinates may be sent",
        "as soon as you end navigation",
        "system settings",
        "only while the app is open",
      ],
    ],
    [
      "de",
      [
        "genauen Standort",
        "gesperrtem Bildschirm",
        "auf diesem Gerät",
        "nicht als Standortverlauf gespeichert",
        "Koordinaten können",
        "sobald du die Navigation beendest",
        "Systemeinstellungen",
        "während die App geöffnet ist",
      ],
    ],
  ])("states every disclosed fact in %s", async (locale, claims) => {
    const view = await renderDisclosure(locale);
    const rendered = allText(view);

    for (const claim of claims) expect(rendered).toContain(claim);
  });

  it.each<[MobileLocale, string[]]>([
    ["en", ["Continue", "Foreground only", "Not now"]],
    ["de", ["Weiter", "Nur im Vordergrund", "Jetzt nicht"]],
  ])("offers exactly the three explicit choices in %s", async (locale, labels) => {
    const view = await renderDisclosure(locale);

    for (const label of labels) expect(view.getByLabelText(label)).toBeTruthy();
  });

  it("reports each choice separately", async () => {
    const onAccept = jest.fn();
    const onForegroundOnly = jest.fn();
    const onDismiss = jest.fn();
    const view = await renderDisclosure("en", { onAccept, onForegroundOnly, onDismiss });

    await fireEvent.press(view.getByTestId("permission-continue"));
    await fireEvent.press(view.getByTestId("permission-foreground-only"));
    await fireEvent.press(view.getByTestId("permission-not-now"));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onForegroundOnly).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("labels every control for a screen reader", async () => {
    const view = await renderDisclosure("de");

    for (const testID of [
      "permission-continue",
      "permission-foreground-only",
      "permission-not-now",
    ]) {
      const control = view.getByTestId(testID);
      expect(control.props.accessibilityRole).toBe("button");
      expect(String(control.props.accessibilityLabel ?? "")).not.toHaveLength(0);
    }
  });

  it("does not itself trigger an operating-system prompt", async () => {
    const view = await renderDisclosure("en");

    // The screen only reports a choice; requesting is the controller's job, so
    // nothing here can produce a dialog the user did not ask for.
    expect(allText(view)).not.toContain("requestPermission");
  });
});

describe("PermissionOutcome", () => {
  const settings = (reason: "cannot-escalate" | "background-in-settings" | "precise-required") =>
    ({ state: "settings-required", platform: "android", reason }) as PermissionFlowState;

  it.each<[string, "cannot-escalate" | "background-in-settings" | "precise-required", string]>([
    [
      "a background grant that only settings can give",
      "background-in-settings",
      "Allow all the time",
    ],
    ["a reduced-accuracy grant", "precise-required", "precise location"],
    ["a permission that can no longer be requested", "cannot-escalate", "can no longer ask"],
  ])("explains %s", async (_label, reason, claim) => {
    const view = render(
      <PermissionOutcome
        locale="en"
        state={settings(reason)}
        onOpenSettings={noop}
        onDismiss={noop}
      />,
    );

    expect(JSON.stringify((await view).toJSON())).toContain(claim);
  });

  it("offers settings and a way out, and nothing else", async () => {
    const view = await render(
      <PermissionOutcome
        locale="en"
        state={settings("background-in-settings")}
        onOpenSettings={noop}
        onDismiss={noop}
      />,
    );

    expect(view.getByTestId("permission-open-settings")).toBeTruthy();
    expect(view.getByTestId("permission-settings-dismiss")).toBeTruthy();
    expect(view.queryByTestId("permission-continue")).toBeNull();
  });

  it("states plainly that navigation is unavailable when denied", async () => {
    const view = await render(
      <PermissionOutcome
        locale="de"
        state={{ state: "denied", canAskAgain: false }}
        onOpenSettings={noop}
        onDismiss={noop}
      />,
    );

    expect(JSON.stringify(view.toJSON())).toContain("Standortzugriff");
    // No settings button: re-asking is exactly what a denied state must not do.
    expect(view.queryByTestId("permission-open-settings")).toBeNull();
  });

  it("renders nothing for a state with no user decision to make", async () => {
    const view = await render(
      <PermissionOutcome
        locale="en"
        state={{ state: "requesting-foreground" }}
        onOpenSettings={noop}
        onDismiss={noop}
      />,
    );

    expect(view.toJSON()).toBeNull();
  });
});
