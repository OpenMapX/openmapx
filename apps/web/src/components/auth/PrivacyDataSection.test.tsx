import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { getPrivacyDataRequests, translate } = vi.hoisted(() => ({
  getPrivacyDataRequests: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock("next-intl", async () => ({
  ...(await import("@/test/intl")).mockNextIntl(),
  useTranslations: () => translate,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  getPrivacyDataRequests,
}));

import { PrivacyDataSection } from "./PrivacyDataSection";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("does not fetch request details when the list arrives after unmount", async () => {
  let resolve!: (value: { requests: { id: string }[] }) => void;
  getPrivacyDataRequests.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const fetch = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal("fetch", fetch);
  const { unmount } = render(<PrivacyDataSection />);
  unmount();
  await act(async () => {
    resolve({ requests: [{ id: "pending-request" }] });
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("settles a failed list request safely after browser teardown", async () => {
  let reject!: (reason: Error) => void;
  getPrivacyDataRequests.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const { unmount } = render(<PrivacyDataSection />);
  unmount();
  await act(async () => {
    vi.stubGlobal("window", undefined);
    try {
      reject(new Error("Request failed after teardown"));
      // Flush both catch and finally while the browser global is unavailable.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("shows a list failure while the section is still mounted", async () => {
  getPrivacyDataRequests.mockRejectedValue(new Error("List unavailable"));
  render(<PrivacyDataSection />);
  expect(await screen.findByRole("alert")).toHaveTextContent("privacyData.loadFailed");
});

it("finishes loading an empty list while mounted", async () => {
  getPrivacyDataRequests.mockResolvedValue({ requests: [] });
  render(<PrivacyDataSection />);
  expect(await screen.findByText("privacyData.noRequests")).toBeVisible();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
