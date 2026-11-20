import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

/** Admin pages whose browser title the catalogue names. */
export type AdminPageTitle =
  | "overview"
  | "activity"
  | "privacySetup"
  | "extensions"
  | "integrations"
  | "bulkConfigure"
  | "integrationDetail"
  | "backups"
  | "services"
  | "serviceDetail"
  | "users"
  | "userDetail"
  | "data"
  | "osm"
  | "transfers"
  | "transit"
  | "operations"
  | "search"
  | "overture";

/** The browser title of an admin page, in the reader's language. */
export async function adminPageMetadata(
  page: AdminPageTitle,
  values?: Record<string, string>,
): Promise<Metadata> {
  const t = await getTranslations("adminPages");
  return { title: t("titleFormat", { page: t(`titles.${page}`, values) }) };
}
