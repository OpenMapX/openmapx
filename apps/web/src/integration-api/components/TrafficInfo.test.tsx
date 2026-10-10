import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, userEvent, waitFor } from "@/test";
import { TrafficInfo } from "./TrafficInfo";

afterEach(cleanup);

it.each(["Escape", "Close", "outside click"] as const)(
  "dismisses traffic info with %s and returns focus to its trigger",
  async (dismissal) => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <TrafficInfo>Traffic explanation</TrafficInfo>
      </NextIntlClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: "About traffic" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
      "Traffic explanation",
    );
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    if (dismissal === "Escape") await user.keyboard("{Escape}");
    else if (dismissal === "Close") await user.click(screen.getByRole("button", { name: "Close" }));
    else {
      // The modal backdrop intentionally has no accessible control role.
      const backdrop = document.querySelector<HTMLElement>(".MuiBackdrop-root");
      expect(backdrop).not.toBeNull();
      await user.click(backdrop as HTMLElement);
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  },
);
