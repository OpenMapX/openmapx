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
