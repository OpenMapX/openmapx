import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, userEvent } from "@/test";
import { SchemaConfigForm } from "../SchemaConfigForm";

afterEach(cleanup);
it("locks config.json winners and never sends them in a save alongside an editable field", async () => {
  const save = vi.fn();
  render(
    <SchemaConfigForm
      schema={{ properties: { endpoint: { type: "string" }, region: { type: "string" } } }}
      resolvedConfig={{
        endpoint: { value: "host-endpoint", source: "config.json" },
        region: { value: "old", source: "database" },
      }}
      onSave={async (diff) => {
        save(diff);
      }}
    />,
  );
  const fields = screen.getAllByRole("textbox");
  expect(fields[0]).toBeDisabled();
  await userEvent.clear(fields[1]!);
  await userEvent.type(fields[1]!, "new");
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  expect(save).toHaveBeenCalledWith({ region: "new" });
  expect(await screen.findByText(/Controlled by the host config file/i)).toBeInTheDocument();
});
