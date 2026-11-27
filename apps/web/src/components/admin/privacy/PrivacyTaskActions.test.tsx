import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nth } from "@/test";
import { PrivacyTaskActions } from "./PrivacyTaskActions";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
describe("operator task actions", () => {
  it("resolves an open operator task with one action and a reason code", async () => {
    const detail = privacyDetail();
    const writes: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, rawInit: unknown) => {
        const init = rawInit as RequestInit | undefined;
        writes.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return privacyJson({ request: detail.request });
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    const button = screen.getByRole("button", { name: "privacyAdmin.workflows.resolveTask" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.reasonCode"), {
      target: { value: "logs-checked" },
    });
    fireEvent.click(button);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.url).toMatch(/\/tasks\/[0-9a-f-]+\/resolution$/);
    expect(writes[0]?.body).toEqual({ version: 3, reasonCode: "logs-checked" });
  });

  it("names the extension an export left out and why, in words", () => {
    const detail = privacyDetail();
    const task = nth(detail.tasks, 0);
    task.registrationId = "extension:acme-tracker";
    task.source = "extension";
    task.publicCode = "extension-not-loaded";
    task.integrationName = "Acme tracker";
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    expect(screen.getByText(/Acme tracker/)).toHaveTextContent(
      "Acme tracker · privacyAdmin.workflows.extensionTaskReasons.extension-not-loaded · privacyAdmin.workflows.taskStates.open",
    );
    expect(screen.queryByText(/extension:acme-tracker/)).toBeNull();
  });

  it("shows an operator-held source as its id and state only", () => {
    const detail = privacyDetail();
    const task = nth(detail.tasks, 0);
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    expect(screen.getByText(new RegExp(task.registrationId))).toHaveTextContent(
      `${task.registrationId} · privacyAdmin.workflows.taskStates.open`,
    );
    expect(screen.queryByText(/operator-preservation-action-required/)).toBeNull();
  });

  it("offers no action for a resolved task", () => {
    const detail = privacyDetail();
    const task = nth(detail.tasks, 0);
    task.status = "resolved";
    task.resolutionCode = "logs-checked";
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    expect(screen.queryByRole("button", { name: "privacyAdmin.workflows.resolveTask" })).toBeNull();
    expect(screen.getByText(/logs-checked/)).toBeInTheDocument();
  });
});
