/** Compatibility projection for the original trusted-configuration callers.
 * One portable implementation owns JSON parsing, ordering and final budgets. */
import {
  parseFeedCredentialMapJson,
  canonicalFeedCredentialMap as validate,
} from "@openmapx/transitous-core/feed-credentials";
export function canonicalFeedCredentialMap(
  input: string | Readonly<Record<string, string>>,
): string {
  try {
    return validate(typeof input === "string" ? parseFeedCredentialMapJson(input) : input)
      .canonicalJson;
  } catch {
    throw Error("Feed credential map exceeds its format or budget");
  }
}

/** Identity of no managed row, never a digest of a secret. */
export const TRANSIT_CREDENTIALS_ABSENT_REVISION =
  "7f1e896e62b3c13fa40bcc4df28f107dab28409a292d5796d1bc91388af92c07";
