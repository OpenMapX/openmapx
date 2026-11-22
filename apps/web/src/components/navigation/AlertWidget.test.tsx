import type { ActiveAlert, RoadAlertType } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const speak = vi.fn();
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => speak }));
const warn = vi.fn();
vi.mock("@/lib/haptics", () => ({ haptics: { warn: () => warn() } }));

import { AlertWidget } from "./AlertWidget";

const alertOf = (type: RoadAlertType, id = `${type}:1`): ActiveAlert =>
  ({
    alert: { id, type, coord: [0, 0], alongMeters: 300 },
    distanceMeters: 120,
  }) as unknown as ActiveAlert;

beforeEach(() => {
  speak.mockClear();
  warn.mockClear();
  useNavigationStore.setState({ voiceEnabled: true });
});
afterEach(() => {
  useNavigationStore.setState({ voiceEnabled: false });
});

describe("AlertWidget", () => {
  it.each(["pedestrian_crossing", "give_way"] as const)(
    "AlertWidget shows but does not speak %s",
    (type) => {
      render(<AlertWidget alert={alertOf(type)} />);
      expect(screen.getByRole("status")).toBeTruthy();
      expect(speak).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("labels a give-way sign", () => {
    render(<AlertWidget alert={alertOf("give_way")} />);
    expect(screen.getByRole("status").textContent).toContain("alertGiveWay");
  });

  it("still speaks a stop sign", () => {
    render(<AlertWidget alert={alertOf("stop")} />);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
