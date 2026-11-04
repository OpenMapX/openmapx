import { act, fireEvent, render } from "@testing-library/react-native";
import { createPermissionPrompter, PermissionPrompts } from "./PermissionPrompts";

function prompter(overrides: Parameters<typeof createPermissionPrompter>[0] = { locale: "en" }) {
  return createPermissionPrompter(overrides);
}

describe("PermissionPrompts", () => {
  it("shows the disclosure and resolves with the user's choice", async () => {
    const instance = prompter();
    const view = await render(<PermissionPrompts prompter={instance} locale="en" />);

    let choice: unknown;
    await act(async () => {
      void instance.ui.showDisclosure().then((value) => {
        choice = value;
      });
    });
    expect(view.getByTestId("permission-disclosure")).toBeTruthy();

    await act(async () => {
      await fireEvent.press(view.getByTestId("permission-foreground-only"));
    });

    expect(choice).toBe("foreground-only");
    expect(view.queryByTestId("permission-disclosure")).toBeNull();
  });

  it("routes Android's background step through the permission request", async () => {
    const requestBackgroundAccess = jest.fn(async () => "background");
    const openSettings = jest.fn(async () => undefined);
    const instance = prompter({
      locale: "en",
      requestBackgroundAccess,
      openSettings,
      waitForReturn: async () => undefined,
    });
    await render(<PermissionPrompts prompter={instance} locale="en" />);

    await act(async () => {
      void instance.ui.showSettingsRequired({
        state: "settings-required",
        platform: "android",
        reason: "background-in-settings",
      });
    });
    await act(async () => {
      await instance.ui.openSystemSettings();
    });

    expect(requestBackgroundAccess).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("opens settings and waits for the user to come back for other reasons", async () => {
    const order: string[] = [];
    const instance = prompter({
      locale: "en",
      requestBackgroundAccess: async () => order.push("request"),
      openSettings: async () => {
        order.push("open");
      },
      // Listening starts before settings open, so the return cannot be missed.
      waitForReturn: () => {
        order.push("listening");
        return Promise.resolve().then(() => {
          order.push("returned");
        });
      },
    });
    await render(<PermissionPrompts prompter={instance} locale="en" />);

    await act(async () => {
      void instance.ui.showSettingsRequired({
        state: "settings-required",
        platform: "android",
        reason: "precise-required",
      });
    });
    await act(async () => {
      await instance.ui.openSystemSettings();
    });

    expect(order).toEqual(["listening", "open", "returned"]);
  });

  it("offers foreground-only through a confirmation", async () => {
    const confirm = jest.fn(async () => true);
    const instance = prompter({ locale: "en", confirm });

    await expect(instance.ui.offerForegroundOnly()).resolves.toBe("accept");
    confirm.mockResolvedValueOnce(false);
    await expect(instance.ui.offerForegroundOnly()).resolves.toBe("dismiss");
  });
});
