import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GroupedMultiSelectSection } from "./GroupedMultiSelectSection";

const groups = [
  {
    label: "Public",
    icon: <LockOpenIcon />,
    optionIds: ["public", "street"],
    optionLabels: ["Public", "On street"],
  },
  {
    label: "Membership required",
    icon: <LockIcon />,
    optionIds: ["members"],
    optionLabels: ["Members"],
  },
];

describe("GroupedMultiSelectSection", () => {
  it("exposes complete selection state and toggles every option in a group", async () => {
    const onToggle = vi.fn();
    render(
      <GroupedMultiSelectSection
        label="Access"
        groups={groups}
        selected={["public", "street"]}
        onToggle={onToggle}
        tintIcons
      />,
    );

    const publicButton = screen.getByRole("button", { name: /Public/ });
    expect(publicButton.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Membership required/ }).getAttribute("aria-pressed"),
    ).toBe("false");

    await userEvent.click(publicButton);
    expect(onToggle).toHaveBeenCalledWith(["public", "street"]);
  });

  it("supports keyboard activation and preserves the translated group label", async () => {
    const onToggle = vi.fn();
    render(
      <GroupedMultiSelectSection
        label="Zugang"
        groups={groups}
        selected={[]}
        onToggle={onToggle}
      />,
    );

    const membershipButton = screen.getByRole("button", { name: /Membership required/ });
    membershipButton.focus();
    await userEvent.keyboard("{Enter}");

    expect(screen.getByText("Zugang")).not.toBeNull();
    expect(onToggle).toHaveBeenCalledWith(["members"]);
  });
});
