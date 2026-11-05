import { afterEach, expect, it, vi } from "vitest";
import { AdminDraftProvider } from "@/lib/admin/AdminDraftProvider";
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

it("shows legacy host memory units and false booleans honestly in locked controls", () => {
  render(
    <SchemaConfigForm
      schema={{
        properties: {
          OPENMAPX_MEMORY_MIB: { type: "integer", title: "Container memory" },
          ENABLED: { type: "boolean", title: "Optional feature" },
        },
      }}
      resolvedConfig={{
        OPENMAPX_MEMORY_MIB: { value: "16g", source: "env" },
        ENABLED: { value: "False", source: "env" },
      }}
      onSave={async () => {}}
    />,
  );
  expect(screen.getByDisplayValue("16g")).toBeDisabled();
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(screen.getByRole("switch")).toBeDisabled();
});

it("retains an ordinary draft across tab disposal and requires review of a server conflict", async () => {
  const schema = {
    properties: {
      region: { type: "string" },
      password: { type: "string", "x-openmapx-secret": true },
    },
  };
  const view = (show: boolean, region = "old") => (
    <AdminDraftProvider>
      {show ? (
        <SchemaConfigForm
          draftId="service:demo"
          schema={schema}
          resolvedConfig={{
            region: { value: region, source: "database" },
            password: { value: "never", source: "database" },
          }}
          onSave={async () => {}}
        />
      ) : (
        <div>Credentials</div>
      )}
    </AdminDraftProvider>
  );
  const { rerender } = render(view(true));
  await userEvent.clear(screen.getByRole("textbox"));
  await userEvent.type(screen.getByRole("textbox"), "mine");
  rerender(view(false));
  rerender(view(true, "theirs"));
  expect(screen.getByRole("textbox")).toHaveValue("mine");
  expect(screen.getByRole("button", { name: /^Save/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
  expect(screen.getByRole("button", { name: /^Save/ })).not.toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByRole("textbox")).toHaveValue("theirs");
  expect(screen.queryByDisplayValue("never")).not.toBeInTheDocument();
});
