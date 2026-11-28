// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen, userEvent, waitFor, within } from "@/test";
import { AdminToastProvider } from "../../shared/AdminToast";
import { SafeModeNotice } from "../SafeModeNotice";
import { summary } from "./fixtures";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
}));

type State = {
  active: boolean;
  reason: "env" | "operator" | "automatic" | null;
  integrationId: string | null;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The paths the component read since the last `serve`. */
let reads: string[] = [];

function serve(initial: State, leave?: (setState: (next: State) => void) => Response) {
  let state = initial;
  const posted: string[] = [];
  reads = [];
  const read = reads;
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (typeof input === "string" ? init?.method : input.method) ?? "GET";
    if (url.pathname === "/api/admin/safe-mode/leave" && method === "POST") {
      posted.push(url.pathname);
      if (leave)
        return leave((next) => {
          state = next;
        });
      state = { active: false, reason: null, integrationId: null };
      return Response.json(state);
    }
    if (method === "GET") read.push(url.pathname);
    if (url.pathname === "/api/admin/safe-mode") return Response.json(state);
    if (url.pathname === "/api/admin/integrations")
      return Response.json([
        {
          ...summary,
          id: "acme-places",
          name: "Acme Places",
          isBuiltIn: false,
          quality: "community",
          enabled: false,
          status: "safe-mode",
          loadState: "safe-mode",
        },
      ]);
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  return posted;
}

function mount() {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <SafeModeNotice />
      </AdminToastProvider>
    </QueryClientProvider>,
  );
}

it("shows nothing while safe mode is off", async () => {
  serve({ active: false, reason: null, integrationId: null });
  mount();
  await waitFor(() => expect(screen.queryByText("Safe mode is on")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Leave safe mode" })).not.toBeInTheDocument();
});

it("names the operator as the reason and leaves safe mode after confirmation", async () => {
  const posted = serve({ active: true, reason: "operator", integrationId: null });
  mount();

  const notice = await screen.findByRole("region", { name: "Safe mode is on" });
  expect(notice).toHaveTextContent("An operator turned safe mode on.");
  const user = userEvent.setup();
  await user.click(within(notice).getByRole("button", { name: "Leave safe mode" }));

  const dialog = await screen.findByRole("dialog", { name: "Leave safe mode?" });
  expect(dialog).toHaveTextContent("If one of them stopped the API, it can stop it again.");
  expect(posted).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Leave safe mode" }));

  await waitFor(() => expect(posted).toEqual(["/api/admin/safe-mode/leave"]));
  expect(
    await screen.findByText(
      "Left safe mode; the installed extensions are loaded. Check the list for any that failed.",
    ),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Safe mode is on" })).not.toBeInTheDocument(),
  );
});

it("keeps safe mode when the confirmation is cancelled", async () => {
  const posted = serve({ active: true, reason: "operator", integrationId: null });
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Leave safe mode" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(posted).toEqual([]);
  // The closing dialog hides the page from the accessibility tree until it is gone.
  expect(await screen.findByRole("region", { name: "Safe mode is on" })).toBeInTheDocument();
});

it("names the integration automatic safe mode blames", async () => {
  serve({ active: true, reason: "automatic", integrationId: "acme-places" });
  mount();

  const notice = await screen.findByRole("region", { name: "Safe mode is on" });
  await waitFor(() =>
    expect(notice).toHaveTextContent(
      "The API stopped three times within ten minutes while Acme Places was loading or running, so it started in safe mode.",
    ),
  );
  expect(notice).toHaveTextContent(
    "Disable or update the extension Acme Places belongs to before you leave safe mode",
  );
  expect(within(notice).getByRole("button", { name: "Leave safe mode" })).toBeInTheDocument();
});

it("explains safe mode the environment forces, without a button", async () => {
  serve({ active: true, reason: "env", integrationId: null });
  mount();

  const notice = await screen.findByRole("region", { name: "Safe mode is on" });
  expect(notice).toHaveTextContent("OPENMAPX_SAFE_MODE=1 keeps the API in safe mode.");
  expect(notice).toHaveTextContent(
    "remove the variable from infra/docker/.env, then run pnpm openmapx compose up on the host",
  );
  expect(notice).not.toHaveTextContent("restart the api service");
  expect(within(notice).queryByRole("button")).not.toBeInTheDocument();
});

it("explains automatic safe mode that names no integration", async () => {
  serve({ active: true, reason: "automatic", integrationId: null });
  mount();

  const notice = await screen.findByRole("region", { name: "Safe mode is on" });
  expect(notice).toHaveTextContent(
    "OpenMapX stopped three times within ten minutes after installed extensions had started loading",
  );
  // A crash in built-in code is counted too, without a name.
  expect(notice).toHaveTextContent("The crashes name no extension.");
  expect(notice).toHaveTextContent("If it names none, the cause may be in OpenMapX itself.");
  expect(notice).not.toHaveTextContent("while  was loading");
  expect(within(notice).getByRole("button", { name: "Leave safe mode" })).toBeInTheDocument();
});

it("shows the state after a leave whose reload failed, and the failure", async () => {
  serve({ active: true, reason: "operator", integrationId: null }, (setState) => {
    // The API left safe mode, then the reload of the extensions failed.
    setState({ active: false, reason: null, integrationId: null });
    return Response.json({ error: "Reloading the integrations failed" }, { status: 500 });
  });
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Leave safe mode" }));
  const dialog = await screen.findByRole("dialog");
  reads.length = 0;
  await user.click(within(dialog).getByRole("button", { name: "Leave safe mode" }));

  expect(await screen.findByText("Reloading the integrations failed")).toBeInTheDocument();
  // The notice is read again, and with it the list it sits on.
  await waitFor(() => expect(reads).toContain("/api/admin/safe-mode"));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Safe mode is on" })).not.toBeInTheDocument(),
  );
});

it("says why safe mode could not be left and stays in it", async () => {
  serve({ active: true, reason: "operator", integrationId: null }, () =>
    Response.json({ error: "Safe mode is forced by OPENMAPX_SAFE_MODE" }, { status: 409 }),
  );
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Leave safe mode" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Leave safe mode" }));

  expect(await screen.findByText("Safe mode is forced by OPENMAPX_SAFE_MODE")).toBeInTheDocument();
  // The closing dialog hides the page from the accessibility tree until it is gone.
  expect(await screen.findByRole("region", { name: "Safe mode is on" })).toBeInTheDocument();
});
