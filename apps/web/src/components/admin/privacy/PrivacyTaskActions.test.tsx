import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("offers no action for a resolved task", () => {
    const detail = privacyDetail();
    detail.tasks[0]!.status = "resolved";
    detail.tasks[0]!.resolutionCode = "logs-checked";
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    expect(screen.queryByRole("button", { name: "privacyAdmin.workflows.resolveTask" })).toBeNull();
    expect(screen.getByText(/logs-checked/)).toBeInTheDocument();
  });
});
