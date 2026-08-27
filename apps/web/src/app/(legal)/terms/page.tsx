import { fetchCapabilities, fetchDisclosures, fetchIntegrations } from "@openmapx/core/server-api";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { termsNav } from "./sections";

// Render per-request so the data-source / attribution tables reflect the
// integrations enabled at runtime (matching /licenses), not the build-time
// default enablement.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("termsOfService")} — OpenMapX`,
    description: t("termsDescription"),
  };
}

export default async function TermsPage() {
  const locale = await getLocale();
  const sections = termsNav(locale === "de" ? "de" : "en");
  const Content =
    locale === "de"
      ? (await import("./content.de")).default
      : (await import("./content.en")).default;

  const [capabilities, integrations, disclosures] = await Promise.all([
    fetchCapabilities(),
    fetchIntegrations(),
    fetchDisclosures(),
  ]);

  return (
    <LegalPageShell sections={sections}>
      <Content capabilities={capabilities} integrations={integrations} disclosures={disclosures} />
    </LegalPageShell>
  );
}
