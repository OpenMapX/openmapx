import { useTranslations } from "next-intl";

declare const adminNamespace: unique symbol;

/**
 * A translator bound to one catalogue namespace. Helpers outside components
 * declare the namespace they read, such as `AdminTranslator<"adminServices">`,
 * so passing another namespace's translator, or an unmarked one, fails to
 * compile. Components get one from `useAdminTranslations`.
 */
export type AdminTranslator<Namespace extends string> = ReturnType<typeof useTranslations> & {
  readonly [adminNamespace]: Namespace;
};

/** `useTranslations` for a component that hands its translator to helpers. */
export function useAdminTranslations<Namespace extends string>(
  namespace: Namespace,
): AdminTranslator<Namespace> {
  return useTranslations(namespace) as unknown as AdminTranslator<Namespace>;
}
