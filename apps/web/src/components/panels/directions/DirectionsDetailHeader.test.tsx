import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { DirectionsDetailHeader } from "./DirectionsDetailHeader";

function renderHeader(props: Partial<React.ComponentProps<typeof DirectionsDetailHeader>> = {}) {
  const onBack = props.onBack ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <DirectionsDetailHeader
        originLabel="Central Station"
        destinationLabel="City Hall"
        onBack={onBack}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return onBack;
}

describe("DirectionsDetailHeader", () => {
  it("renders endpoints and intermediate stops with an accessible back action", async () => {
    const onBack = renderHeader({ viaLabels: ["Museum", "Park"] });

    expect(screen.getByText("Central Station")).not.toBeNull();
    expect(screen.getByText("City Hall")).not.toBeNull();
    expect(screen.getByText("via Museum, Park")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("uses translated endpoint fallbacks and omits empty via labels", () => {
    renderHeader({ originLabel: "", destinationLabel: "", viaLabels: ["", "Park", ""] });

    expect(screen.getByText("Origin")).not.toBeNull();
    expect(screen.getByText("Destination")).not.toBeNull();
    expect(screen.getByText("via Park")).not.toBeNull();
  });
});
