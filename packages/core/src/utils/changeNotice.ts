import {
  canonicalLicenseExpression,
  type Licensing,
  parseLicensing,
} from "@openmapx/mobility-core/licensing";

/**
 * Licences whose text asks a changed version for no notice that it was
 * changed. OpenConditions' licence registry (`changeNotice: false`) read each
 * of the data licences; the software and public-domain dedications ask none
 * by their nature. A licence missing here asks for the notice.
 */
const NO_CHANGE_NOTICE: ReadonlySet<string> = new Set(
  [
    "CC0-1.0",
    "PDDL-1.0",
    "ODbL-1.0",
    "DL-DE-ZERO-2.0",
    "etalab-2.0",
    "LicenseRef-Licence-Ouverte-1.0",
    "OGL-UK-3.0",
    "OGL-Canada-2.0",
    "LicenseRef-OGL-BC",
    "LicenseRef-OGL-ON",
    "OGDL-Taiwan-1.0",
    "LicenseRef-Singapore-ODL-1.0",
    "LicenseRef-KOGL-Type-1",
    "LicenseRef-Modellicentie-Gratis-Hergebruik-1.0",
    "LicenseRef-opentransportdata-swiss-ToU",
    "LicenseRef-opendata-swiss-terms-by-ask",
    "LicenseRef-NLR-Developer-Network-Terms",
    "LicenseRef-HK-CSDI-ToU",
    "LicenseRef-HK-Gov-Open-Data",
    "LicenseRef-TfL-Transport-Data-Service",
    "LicenseRef-National-Highways-Transport-Data-Feeds",
    "LicenseRef-511NY-DAA",
    "LicenseRef-Caltrans-Conditions-of-Use",
    "LicenseRef-ECCC-Data-Servers-End-use",
    "LicenseRef-US-Gov-Public-Domain",
    "CDLA-Permissive-2.0",
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
  ].map((id) => id.toLowerCase()),
);

/** The scopes whose licence covers what a credit shows. */
const SHOWN_SCOPES: ReadonlySet<string> = new Set(["data", "imagery", "style"]);

const asksNone = (id: string): boolean => NO_CHANGE_NOTICE.has(id.replace(/\+$/, "").toLowerCase());

/**
 * Whether a canonical SPDX expression asks for the notice: a choice (`OR`)
 * only when every option does, since a reuser may pick the one that does
 * not; a combination (`AND`) when any part does. An exception (`WITH`)
 * leaves its licence's condition as it is.
 */
function expressionAsks(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const primary = (): boolean => {
    const token = tokens[at++];
    if (token === undefined) return true;
    if (token === "(") {
      const asks = choice();
      at++;
      return asks;
    }
    if (peek() === "WITH") at += 2;
    return !asksNone(token);
  };
  const combination = (): boolean => {
    let asks = primary();
    while (peek() === "AND") {
      at++;
      asks = primary() || asks;
    }
    return asks;
  };
  const choice = (): boolean => {
    let asks = combination();
    while (peek() === "OR") {
      at++;
      asks = combination() && asks;
    }
    return asks;
  };
  return choice();
}

/**
 * Whether the licences of a credit's shown material ask a changed version to
 * say it was changed (CC BY's "indicate if You modified", the
 * Veränderungshinweis of the Datenlizenz Deutschland and the GeoNutzV, NLOD's
 * "indicate that changes have been made"). Anything it cannot read asks:
 * no licensing, no binding for the shown material, a licence decided per item
 * or not known.
 */
export function requiresChangeNotice(licensing: Licensing | undefined): boolean {
  const shown = parseLicensing(licensing)?.bindings.filter((b) => SHOWN_SCOPES.has(b.scope));
  if (!shown || shown.length === 0) return true;
  return shown.some(({ license }) => {
    switch (license.kind) {
      case "spdx": {
        const expression = canonicalLicenseExpression(license.expression);
        return expression === undefined || expressionAsks(expression);
      }
      case "custom":
        return !asksNone(license.id);
      case "public-domain":
      case "status":
        return false;
      default:
        return true;
    }
  });
}
