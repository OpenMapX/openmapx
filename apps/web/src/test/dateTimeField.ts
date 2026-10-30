import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function required<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`expected ${what}`);
  return element;
}

/**
 * Enters a local `YYYY-MM-DDTHH:mm` into a `DateTimeField` the way a user
 * would: the date in its date field, the time through the picker's keyboard
 * mode. Works with the 12- and 24-hour picker and with real or mocked messages,
 * since it finds the controls by structure rather than by label.
 */
export async function enterDateTime(group: HTMLElement, value: string): Promise<void> {
  const [date, time] = value.split("T");
  const [hours, minutes] = (time ?? "").split(":").map(Number);
  if (!date || hours === undefined || minutes === undefined) {
    throw new Error(`expected YYYY-MM-DDTHH:mm, got ${value}`);
  }

  const dateInput = required(group.querySelector('input[type="date"]'), "a date input");
  fireEvent.change(dateInput, { target: { value: date } });

  await userEvent.click(
    required(group.querySelector('input[aria-haspopup="dialog"]'), "a time field"),
  );
  const dialog = screen.getByRole("dialog");
  await userEvent.click(
    required(dialog.querySelector('[data-picker-action="toggle-mode"]'), "the keyboard toggle"),
  );
  const [hourInput, minuteInput] = dialog.querySelectorAll<HTMLInputElement>(
    'input[inputmode="numeric"]',
  );
  const twelveHour = within(dialog).queryByRole("button", { name: "PM" }) !== null;
  await userEvent.clear(required(hourInput, "an hour input"));
  await userEvent.type(
    required(hourInput, "an hour input"),
    String(twelveHour ? hours % 12 || 12 : hours),
  );
  await userEvent.clear(required(minuteInput, "a minute input"));
  await userEvent.type(required(minuteInput, "a minute input"), String(minutes).padStart(2, "0"));
  if (twelveHour) {
    await userEvent.click(within(dialog).getByRole("button", { name: hours >= 12 ? "PM" : "AM" }));
  }
  await userEvent.click(
    required(dialog.querySelector('[data-picker-action="confirm"]'), "the OK button"),
  );
}
