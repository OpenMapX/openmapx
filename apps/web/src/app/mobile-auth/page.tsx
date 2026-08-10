import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type AuthPurpose, MobileAuthClient } from "./MobileAuthClient";

/**
 * The fixed-origin entry point for system-browser authentication.
 *
 * Rendered per request because it reads the session, and deliberately
 * `noindex`: it is a machine-initiated page with a one-shot purpose, and there
 * is nothing here for a search engine or a shared link to usefully reach.
 */
export const dynamic = "force-dynamic";

const PURPOSES: ReadonlySet<string> = new Set<AuthPurpose>([
  "sign-in",
  "link-provider",
  "add-passkey",
]);

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mobileAuth");
  return {
    title: `${t("title")} · OpenMapX`,
    // A search result pointing at a half-finished auth handoff helps nobody.
    robots: { index: false, follow: false },
    // Nothing downstream of this page should learn the purpose or state that
    // its URL carries.
    referrer: "no-referrer",
  };
}

function readPurpose(value: string | undefined): AuthPurpose {
  return value && PURPOSES.has(value) ? (value as AuthPurpose) : "sign-in";
}

/** Bounded exactly like the server's own check, so neither side is the loose one. */
function readBounded(value: string | undefined, min: number, max: number): string {
  if (typeof value !== "string") return "";
  if (value.length < min || value.length > max) return "";
  return BASE64URL.test(value) ? value : "";
}

export default async function MobileAuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("mobileAuth");
  const params = await searchParams;
  const single = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const purpose = readPurpose(single("purpose"));
  const state = readBounded(single("state"), 16, 128);
  const codeChallenge = readBounded(single("code_challenge"), 43, 128);
  // The method is not read from the query and then trusted; S256 is the only
  // one this accepts, so anything else is simply a malformed request.
  const method = single("code_challenge_method");

  if (!state || !codeChallenge || method !== "S256") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 py-10">
        <p role="alert" className="max-w-sm text-center">
          {t("invalidRequest")}
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-10">
      <MobileAuthClient
        purpose={purpose}
        state={state}
        codeChallenge={codeChallenge}
        callbackScheme={process.env.NEXT_PUBLIC_MOBILE_SCHEME ?? "openmapx"}
      />
    </main>
  );
}
