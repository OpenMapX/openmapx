/**
 * Shared rendering helpers for the email-processor disclosure in the Privacy
 * Policy (§10), so the DE and EN content files don't each carry a copy of the
 * country/transfer prose.
 */
type LegalLocale = "en" | "de";

/**
 * Localized country name from an ISO 3166-1 alpha-2 code, falling back to the
 * raw code (uppercased) so a configured country is never silently dropped.
 */
export function emailCountryName(code: string, locale: LegalLocale): string {
  const cc = code.trim().toUpperCase();
  if (!cc) return "";
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

const TRANSFER_NOTES: Record<LegalLocale, Record<string, string>> = {
  de: {
    adequacy:
      "Die Übermittlung erfolgt in ein Land, für das ein Angemessenheitsbeschluss der EU-Kommission besteht.",
    dpf: "Der Anbieter ist unter dem EU-U.S. Data Privacy Framework zertifiziert.",
    scc: "Die Übermittlung in ein Drittland erfolgt auf Grundlage der EU-Standardvertragsklauseln (Art. 46 DSGVO).",
    eea: "Der Anbieter ist im Europäischen Wirtschaftsraum (EWR) ansässig; eine Übermittlung in ein Drittland findet nicht statt.",
  },
  en: {
    adequacy:
      "The transfer is to a country covered by an adequacy decision of the European Commission.",
    dpf: "The provider is certified under the EU-U.S. Data Privacy Framework.",
    scc: "Any transfer to a third country is made on the basis of the EU Standard Contractual Clauses (Art. 46 GDPR).",
    eea: "The provider is based in the European Economic Area (EEA); no transfer to a third country takes place.",
  },
};

/** Transfer-safeguard sentence for the given TransferSafeguard value, or "". */
export function emailTransferNote(transfer: string, locale: LegalLocale): string {
  return TRANSFER_NOTES[locale][transfer] ?? "";
}
