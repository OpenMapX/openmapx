import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { job } from "../activity/__tests__/fixtures";
import { SystemMaintenance } from "./SystemMaintenance";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("continues maintenance polling through cancel_pending until terminal completion", async () => {
  vi.useFakeTimers();
  let reads = 0;
  let posts = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return Response.json({ jobId: "check-job" });
    }
    if (input.includes("/check-job?source=application")) {
      reads += 1;
      return Response.json({
        ...job({ id: "check-job", cancelable: false }),
        status: reads < 3 ? "cancel_pending" : "success",
      });
    }
    return Response.json({
      deployment: {
        dockerAvailable: true,
        composeRendered: true,
        hostControlConfigured: true,
        maintenanceReady: true,
      },
      release: { currentReleaseId: "current" },
      images: [],
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <SystemMaintenance />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("cancel_pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
    const completedReads = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(reads).toBe(completedReads);
    expect(posts).toBe(1);
  } finally {
    cleanup();
    client.clear();
  }
});

it("keeps host instructions after a raced apply failure and clears them after a fresh successful check", async () => {
  const status = {
    deployment: {
      dockerAvailable: true,
      composeRendered: true,
      hostControlConfigured: true,
      maintenanceReady: true,
    },
    release: {
      currentReleaseId: "old",
      availableReleaseId: "release-123",
      availableDigest: "a".repeat(64),
    },
    images: [
      {
        id: "ops-agent",
        name: "Operations agent",
        image: "agent",
        containerState: "running",
        runningImageId: "agent",
        localImageId: "agent",
        updateAvailable: false,
        status: "up-to-date",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      const init = args[1] as RequestInit | undefined;
      if (init?.method === "POST")
        return Response.json({ jobId: url.endsWith("/check") ? "check-job" : "apply-job" });
      if (url.includes("/apply-job?source=application"))
        return Response.json(
          job({
            id: "apply-job",
            status: "failed",
            error: "Operations request failed",
            result: { errorCode: "host_update_required" },
            cancelable: false,
          }),
        );
      if (url.includes("/check-job?source=application"))
        return Response.json(
          job({
            id: "check-job",
            status: "success",
            error: null,
            result: ["checked", { nested: true }],
            cancelable: false,
          }),
        );
      return Response.json(status);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <SystemMaintenance />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update OpenMapX" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "UPDATE OPENMAPX" } });
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Host update required"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("previous agent keeps running");
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled();
    // The failed job is no longer tracked, but its instructions remain visible.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled();
  } finally {
    client.clear();
  }
});

// Rejected maintenance submissions: real QueryClient and mutations, controlled fetch, synthetic data.
const readyDeployment = {
  dockerAvailable: true,
  composeRendered: true,
  hostControlConfigured: true,
  maintenanceReady: true,
};
const agentImage = {
  id: "ops-agent",
  name: "Operations agent",
  image: "agent",
  containerState: "running",
  runningImageId: "agent",
  localImageId: "agent",
  updateAvailable: false,
  status: "up-to-date",
};
const checkedRelease = {
  currentReleaseId: "old",
  availableReleaseId: "release-123",
  availableDigest: "a".repeat(64),
};

function tooManyRequests(headers: Record<string, string>, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 429, headers });
}

function installAdmissionFetch(options: { checked?: boolean; applyResponses: Response[] }) {
  const applyBodies: unknown[] = [];
  const calls = { checkPosts: 0, applyPosts: 0, applyJobReads: 0, checkJobReads: 0 };
  let checked = options.checked ?? false;
  const applyResponses = [...options.applyResponses];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      if (url.endsWith("/updates/check")) {
        calls.checkPosts += 1;
        return Response.json({ jobId: "check-job" });
      }
      calls.applyPosts += 1;
      applyBodies.push(JSON.parse(String(init.body)));
      return applyResponses.shift() ?? Response.json({ jobId: "apply-job" });
    }
    if (url.includes("/check-job?source=application")) {
      calls.checkJobReads += 1;
      checked = true;
      return Response.json(
        job({ id: "check-job", status: "success", error: null, cancelable: false }),
      );
    }
    if (url.includes("/apply-job?source=application")) {
      calls.applyJobReads += 1;
      return Response.json(job({ id: "apply-job", status: "running" }));
    }
    return Response.json({
      deployment: readyDeployment,
      release: checked ? checkedRelease : { currentReleaseId: "old" },
      images: [agentImage],
    });
  });
  return { calls, applyBodies };
}

async function settle(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderMaintenance() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SystemMaintenance />
    </QueryClientProvider>,
  );
  return client;
}

async function openConfirmedDialog({ keepBackup = true } = {}) {
  fireEvent.click(screen.getByRole("button", { name: "Update OpenMapX" }));
  await settle();
  if (!keepBackup) fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "UPDATE OPENMAPX" } });
}

it("applies a just-checked release; a rejected apply keeps the dialog and retries only on demand", async () => {
  vi.useFakeTimers();
  const { calls, applyBodies } = installAdmissionFetch({
    applyResponses: [tooManyRequests({ "Retry-After": "30" }, { retryAfter: 30 })],
  });
  const client = renderMaintenance();
  try {
    await settle();
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await settle(3_100);
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled();

    await openConfirmedDialog({ keepBackup: false });
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle();

    expect(calls.applyPosts).toBe(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("UPDATE OPENMAPX");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("dialog")).toHaveTextContent("release-123");
    expect(screen.getByRole("dialog")).toHaveTextContent("Too many requests");
    expect(screen.getByRole("dialog")).toHaveTextContent("30 seconds");
    expect(screen.getByRole("button", { name: "Update application" })).toBeDisabled();
    // A rejected admission is not a tracked job and is never polled or retried by itself.
    expect(calls.applyJobReads).toBe(0);

    await settle(29_000);
    expect(screen.getByRole("button", { name: "Update application" })).toBeDisabled();
    await settle(1_500);
    expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();
    expect(calls.applyPosts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle(1_000);
    expect(calls.applyPosts).toBe(2);
    expect(applyBodies).toEqual([
      {
        confirmation: "UPDATE OPENMAPX",
        createBackup: false,
        releaseId: "release-123",
        expectedDigest: "a".repeat(64),
      },
      {
        confirmation: "UPDATE OPENMAPX",
        createBackup: false,
        releaseId: "release-123",
        expectedDigest: "a".repeat(64),
      },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("OpenMapX update")).toBeInTheDocument();
  } finally {
    cleanup();
    client.clear();
  }
});

it("keeps a busy rejection recoverable without disabling the retry", async () => {
  vi.useFakeTimers();
  const { calls } = installAdmissionFetch({
    checked: true,
    applyResponses: [
      Response.json(
        { error: "A maintenance operation is already active", jobId: "other-job" },
        { status: 409 },
      ),
    ],
  });
  const client = renderMaintenance();
  try {
    await settle();
    await openConfirmedDialog();
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle();

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "A maintenance operation is already active",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("once the active operation has finished");
    expect(screen.getByRole("textbox")).toHaveValue("UPDATE OPENMAPX");
    expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();
    // The conflicting job belongs to someone else; it is not adopted as this submission's job.
    expect(calls.applyJobReads).toBe(0);
    await settle(10_000);
    expect(calls.applyPosts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle(1_000);
    expect(calls.applyPosts).toBe(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally {
    cleanup();
    client.clear();
  }
});

const unusableRetryMetadata: [string, Record<string, string>, unknown][] = [
  [
    "a non-numeric Retry-After and negative body value",
    { "Retry-After": "soon" },
    { retryAfter: -5 },
  ],
  ["no retry metadata", {}, { error: "Too many requests" }],
  ["an implausibly long Retry-After", { "Retry-After": "999999999" }, {}],
];

it.each(unusableRetryMetadata)(
  "does not invent an indefinite disable for %s",
  async (_name, headers, body) => {
    vi.useFakeTimers();
    const { calls } = installAdmissionFetch({
      checked: true,
      applyResponses: [tooManyRequests(headers, body)],
    });
    const client = renderMaintenance();
    try {
      await settle();
      await openConfirmedDialog();
      fireEvent.click(screen.getByRole("button", { name: "Update application" }));
      await settle();
      expect(screen.getByRole("dialog")).toHaveTextContent("Too many requests");
      expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();
      expect(calls.applyPosts).toBe(1);
    } finally {
      cleanup();
      client.clear();
    }
  },
);

it("uses a valid body retryAfter when the header is missing, and an HTTP-date header", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T08:00:00.000Z"));
  const { calls } = installAdmissionFetch({
    checked: true,
    applyResponses: [
      tooManyRequests({}, { retryAfter: 5 }),
      tooManyRequests({ "Retry-After": "Fri, 23 Oct 2026 08:00:20 GMT" }),
    ],
  });
  const client = renderMaintenance();
  try {
    await settle();
    await openConfirmedDialog();
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle();
    expect(screen.getByRole("dialog")).toHaveTextContent("5 seconds");
    expect(screen.getByRole("button", { name: "Update application" })).toBeDisabled();
    await settle(5_100);
    expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle();
    expect(calls.applyPosts).toBe(2);
    expect(screen.getByRole("dialog")).toHaveTextContent("seconds");
    expect(screen.getByRole("button", { name: "Update application" })).toBeDisabled();
  } finally {
    cleanup();
    client.clear();
  }
});

const unusableRetryAfterHeaders: [string, Record<string, string>][] = [
  ["a negative Retry-After", { "Retry-After": "-1" }],
  ["an out-of-range Retry-After", { "Retry-After": "999999999" }],
  ["a non-date Retry-After", { "Retry-After": "soon" }],
  ["an impossible HTTP date", { "Retry-After": "Fri, 99 Oct 2026 08:00:20 GMT" }],
  ["a nonexistent calendar date", { "Retry-After": "Fri, 31 Sep 2026 08:00:20 GMT" }],
  ["an unknown weekday", { "Retry-After": "Foo, 23 Oct 2026 08:00:20 GMT" }],
];

it.each(unusableRetryAfterHeaders)(
  "falls back to a valid body retryAfter when the header is %s",
  async (_name, headers) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T08:00:00.000Z"));
    const { calls } = installAdmissionFetch({
      checked: true,
      applyResponses: [tooManyRequests(headers, { retryAfter: 7 })],
    });
    const client = renderMaintenance();
    try {
      await settle();
      await openConfirmedDialog();
      fireEvent.click(screen.getByRole("button", { name: "Update application" }));
      await settle();
      expect(screen.getByRole("dialog")).toHaveTextContent("7 seconds");
      expect(screen.getByRole("button", { name: "Update application" })).toBeDisabled();
      await settle(7_100);
      expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();
      expect(calls.applyPosts).toBe(1);
    } finally {
      cleanup();
      client.clear();
    }
  },
);

it("does not present a host-unavailable 409 as an active operation", async () => {
  vi.useFakeTimers();
  const { calls } = installAdmissionFetch({
    checked: true,
    applyResponses: [
      Response.json(
        {
          error: "Host maintenance is unavailable through the operations agent.",
          deployment: { ...readyDeployment, maintenanceReady: false },
        },
        { status: 409 },
      ),
    ],
  });
  const client = renderMaintenance();
  try {
    await settle();
    await openConfirmedDialog();
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Host maintenance is unavailable");
    expect(dialog).not.toHaveTextContent("active operation");
    expect(dialog).toHaveTextContent("host-control readiness");
    expect(screen.getByRole("textbox")).toHaveValue("UPDATE OPENMAPX");
    expect(screen.getByRole("button", { name: "Update application" })).not.toBeDisabled();
    expect(calls.applyJobReads).toBe(0);
    expect(calls.applyPosts).toBe(1);
  } finally {
    cleanup();
    client.clear();
  }
});

it("keeps each action's wait and feedback independent when another action is rejected", async () => {
  vi.useFakeTimers();
  const posts: string[] = [];
  const diagnosticsResponses = [
    tooManyRequests({ "Retry-After": "5" }, { retryAfter: 5 }),
    Response.json({ jobId: "diagnostics-job" }),
  ];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url.slice(url.lastIndexOf("/system/") + 8));
      return url.endsWith("/updates/check")
        ? tooManyRequests({ "Retry-After": "30" }, { retryAfter: 30 })
        : (diagnosticsResponses.shift() ?? Response.json({ jobId: "diagnostics-job" }));
    }
    if (url.includes("/diagnostics-job?source=application")) {
      return Response.json(
        job({ id: "diagnostics-job", status: "success", error: null, cancelable: false }),
      );
    }
    return Response.json({ deployment: readyDeployment, release: {}, images: [] });
  });
  const client = renderMaintenance();
  try {
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics" }));
    await settle();
    // Both rejections stay visible, each with its own wait.
    const alertText = () => screen.getAllByRole("alert").map((alert) => alert.textContent);
    expect(alertText()).toEqual([
      expect.stringContaining("30 seconds"),
      expect.stringContaining("5 seconds"),
    ]);
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run diagnostics" })).toBeDisabled();

    // The shorter wait ends; the longer one is untouched.
    await settle(5_100);
    expect(screen.getByRole("button", { name: "Run diagnostics" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(alertText()[0]).toContain("30 seconds");

    // Submitting the other action does not erase the pending wait or its feedback.
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics" }));
    await settle();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Update check was not queued");
    expect(screen.getByRole("alert")).toHaveTextContent("30 seconds");

    await settle(25_000);
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
    await settle(30_000);
    // Nothing was ever resubmitted automatically.
    expect(posts).toEqual(["updates/check", "diagnostics", "diagnostics"]);
  } finally {
    cleanup();
    client.clear();
  }
});

it("shows a rejected check without tracking a job and re-enables only that action after the wait", async () => {
  vi.useFakeTimers();
  let checkPosts = 0;
  let jobReads = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      checkPosts += 1;
      return tooManyRequests({ "Retry-After": "12" }, { retryAfter: 12 });
    }
    if (String(input).includes("source=application")) jobReads += 1;
    return Response.json({ deployment: readyDeployment, release: {}, images: [] });
  });
  const client = renderMaintenance();
  try {
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests");
    expect(screen.getByRole("alert")).toHaveTextContent("12 seconds");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run diagnostics" })).not.toBeDisabled();
    expect(screen.queryByText("cancel_pending")).not.toBeInTheDocument();
    await settle(12_500);
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
    expect(checkPosts).toBe(1);
    expect(jobReads).toBe(0);
  } finally {
    cleanup();
    client.clear();
  }
});

it("clears the retry timer when the page is disposed during a wait", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) =>
    init?.method === "POST"
      ? tooManyRequests({ "Retry-After": "30" })
      : Response.json({ deployment: readyDeployment, release: {}, images: [] }),
  );
  const client = renderMaintenance();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const timers = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  try {
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics" }));
    await settle();
    expect(screen.getByRole("button", { name: "Run diagnostics" })).toBeDisabled();
    const { calls, results } = (
      timers as unknown as { mock: { calls: unknown[][]; results: { value: unknown }[] } }
    ).mock;
    const waitTimers = results.filter((_, index) => calls[index]?.[1] === 30_000);
    expect(waitTimers).toHaveLength(1);
    cleanup();
    expect(cleared).toHaveBeenCalledWith(waitTimers[0]?.value);
    await settle(31_000);
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
    timers.mockRestore();
    cleared.mockRestore();
    client.clear();
  }
});

it("clears the selected pin rather than the running release, retaining the request key after a lost response", async () => {
  const posts: { url: string; body: unknown; key: string | null }[] = [];
  const status = {
    deployment: {
      dockerAvailable: true,
      composeRendered: true,
      hostControlConfigured: true,
      maintenanceReady: true,
    },
    release: {
      currentReleaseId: "running-release",
      selectedReleaseId: "selected-pin",
      configuredSelector: "main",
    },
    images: [],
  };
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({
        url,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get("idempotency-key"),
      });
      return posts.length === 1
        ? Response.json({ error: "Response unavailable" }, { status: 503 })
        : Response.json({ ok: true, jobId: "clear-pin-job" }, { status: 202 });
    }
    if (url.includes("clear-pin-job"))
      return Response.json(job({ id: "clear-pin-job", status: "running" }));
    return Response.json(status);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <SystemMaintenance />
      </QueryClientProvider>,
    );
    await screen.findByText("Selected pin: selected-pin");
    fireEvent.click(screen.getByRole("button", { name: "Clear selected release pin" }));
    const confirm = screen.getByRole("button", { name: "Clear release pin" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Clear confirmation"), {
      target: { value: "CLEAR RELEASE PIN" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]?.url).toBe("http://api.test/api/admin/system/release/clear");
    expect(posts[0]?.body).toEqual({
      expectedReleaseId: "selected-pin",
      confirmation: "CLEAR RELEASE PIN",
    });
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(screen.getByText("Configured channel: main")).toBeInTheDocument();
  } finally {
    cleanup();
    client.clear();
  }
});
