import { NextIntlClientProvider, useTranslations } from "next-intl";
import { expect, it } from "vitest";
import { render, screen } from "@/test";
import { AdminMessagesProvider } from "./AdminMessagesProvider";

function Both() {
  const common = useTranslations("common");
  const admin = useTranslations("adminShared");
  return (
    <p>
      {common("cancel")} / {admin("save")}
    </p>
  );
}

it("adds admin copy to the public catalogue instead of replacing it", () => {
  render(
    <NextIntlClientProvider locale="de" messages={{ common: { cancel: "Abbrechen" } }}>
      <AdminMessagesProvider messages={{ adminShared: { save: "Speichern" } }}>
        <Both />
      </AdminMessagesProvider>
    </NextIntlClientProvider>,
  );
  expect(screen.getByText("Abbrechen / Speichern")).toBeVisible();
});
