import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { getPrivacyDataRequests, requestPrivacyExport, translate } = vi.hoisted(() => ({
  getPrivacyDataRequests: vi.fn(),
  requestPrivacyExport: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock("next-intl", async () => ({
  ...(await import("@/test/intl")).mockNextIntl(),
  useTranslations: () => translate,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  getPrivacyDataRequests,
  requestPrivacyExport,
}));

import { PENDING_EXPORT_KEY, PrivacyDataSection } from "./PrivacyDataSection";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  sessionStorage.clear();
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

it("sends the person through a fresh sign-in and keeps only the export intent", async () => {
  getPrivacyDataRequests.mockResolvedValue({ requests: [] });
  requestPrivacyExport.mockResolvedValue(
    Response.json({ code: "FRESH_SIGN_IN_REQUIRED" }, { status: 401 }),
  );
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  render(<PrivacyDataSection />);
  await screen.findByText("privacyData.noRequests");
  fireEvent.click(screen.getByRole("button", { name: "privacyData.downloadExport" }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/privacy"));
  expect(Number(sessionStorage.getItem(PENDING_EXPORT_KEY))).toBeGreaterThan(0);
});

it("continues the export once after returning from the fresh sign-in", async () => {
  getPrivacyDataRequests.mockResolvedValue({ requests: [] });
  sessionStorage.setItem(PENDING_EXPORT_KEY, String(Date.now()));
  requestPrivacyExport.mockResolvedValue(
    new Response(new Blob(["zip"]), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="openmapx-data-export-1234abcd.zip"',
      },
    }),
  );
  const createObjectURL = vi.fn(() => "blob:export");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
  render(<PrivacyDataSection />);
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  expect(requestPrivacyExport).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(PENDING_EXPORT_KEY)).toBeNull();
});

it("ignores an expired export intent", async () => {
  getPrivacyDataRequests.mockResolvedValue({ requests: [] });
  sessionStorage.setItem(PENDING_EXPORT_KEY, String(Date.now() - 11 * 60_000));
  render(<PrivacyDataSection />);
  await screen.findByText("privacyData.noRequests");
  expect(requestPrivacyExport).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(PENDING_EXPORT_KEY)).toBeNull();
});
