import {
  fetchCapabilities,
  fetchDisclosures,
  fetchIntegrations,
  fetchLegalConfig,
} from "@openmapx/core/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { privacyNav } from "./sections";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("privacyPolicy")} — OpenMapX`,
    description: t("privacyDescription"),
  };
}

export default async function PrivacyPage() {
  const locale = await getLocale();
  const sections = privacyNav(locale === "de" ? "de" : "en");
  const Content =
    locale === "de"
      ? (await import("./content.de")).default
      : (await import("./content.en")).default;

  const [capabilities, integrations, disclosures, legal] = await Promise.all([
    fetchCapabilities(),
    fetchIntegrations(),
    fetchDisclosures(),
    fetchLegalConfig(),
  ]);

  return (
    <LegalPageShell sections={sections}>
      <Content
        capabilities={capabilities}
        integrations={integrations}
        disclosures={disclosures}
        legal={legal}
      />
    </LegalPageShell>
  );
}
