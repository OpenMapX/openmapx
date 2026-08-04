import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import type { OfflinePackageDownloadProgress } from "@/lib/offlineAreas";
import { render, screen } from "@/test";
import en from "../../../../../../packages/i18n/locales/en.json";
import { OfflinePackageStatus } from "./OfflinePackageStatus";

function renderProgress(progress: OfflinePackageDownloadProgress) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OfflinePackageStatus progress={progress} />
    </NextIntlClientProvider>,
  );
}

function progress(
  overrides: Partial<OfflinePackageDownloadProgress> = {},
): OfflinePackageDownloadProgress {
  return {
    packageId: "fixture",
    status: "downloading",
    bytesReceived: 256,
    bytesTotal: 1024,
    speedBytesPerSecond: 128,
    ...overrides,
  };
}

describe("OfflinePackageStatus", () => {
  it("shows exact transfer progress as percentage, bytes, and speed", () => {
    renderProgress(progress());

    expect(screen.getByText("25%")).not.toBeNull();
    expect(screen.getByText("256 B / 1.0 KB")).not.toBeNull();
    expect(screen.getByText("128 B/s")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  for (const [status, label] of [
    ["preparing", "Preparing the offline package…"],
    ["verifying", "Verifying the downloaded map…"],
  ] as const) {
    it(`keeps ${status} indeterminate`, () => {
      renderProgress(progress({ status, bytesReceived: 0, bytesTotal: 0, speedBytesPerSecond: 0 }));

      expect(screen.getByText(label)).not.toBeNull();
      expect(screen.queryByText(/%$/)).toBeNull();
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    });
  }

  it("clamps reported transfer progress to one hundred percent", () => {
    renderProgress(progress({ bytesReceived: 2048 }));

    expect(screen.getByText("100%")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });
});
