import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/test";
import { ServiceConfigForm } from "./ServiceConfigForm";

vi.mock("../activity/activityQueries", () => ({
  useActivityClient: () => ({ apiUrl: "http://synthetic.invalid" }),
}));
afterEach(cleanup);
it("clears a saved resource through explicit reset while leaving unrelated values untouched", async () => {
  const save = vi.fn(async () => {});
  render(
    <ServiceConfigForm
      serviceId="redis"
      schema={{
        type: "object",
        properties: {
          OPENMAPX_MEMORY_MIB: { type: "integer", title: "Container memory" },
          WORKERS: { type: "integer", title: "Workers" },
        },
      }}
      resolvedConfig={{
        OPENMAPX_MEMORY_MIB: { value: 4096, source: "database" },
        WORKERS: { value: 4, source: "database" },
      }}
      onSave={async (values) => {
        save(values);
      }}
    />,
  );
  const inputs = screen.getAllByRole("spinbutton");
  fireEvent.change(inputs[0]!, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ OPENMAPX_MEMORY_MIB: null }));
});
