import { type NextRequest, NextResponse } from "next/server";
import { buildCsp, cspNonce } from "./lib/csp";

/**
 * Per-request security headers and locale detection.
 *
 * The Content-Security-Policy lives here rather than in `next.config.ts` because
 * it now carries a nonce, and a nonce that is not per-request is not a nonce —
 * it is a shared secret printed in a static header, which an attacker reads off
 * the response before using it. Two policies would also be worse than one: when
 * a static header and a dynamic one disagree, browsers enforce both, and the
 * resulting failures are extremely hard to attribute.
 */
export function proxy(request: NextRequest) {
  const nonce = cspNonce();
  const csp = buildCsp(nonce, {
    development: process.env.NODE_ENV !== "production",
  });

  // Next reads this to nonce the framework's own inline scripts. Set on the
  // forwarded request, not just the response, because the render happens
  // downstream of here.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  // Locale is detected downstream from `NEXT_LOCALE` or Accept-Language; no
  // cookie is set here. The cookie is only written when the user explicitly
  // switches language (see setLocale.ts), which keeps us compliant with
  // TDDDG §25(2).
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|api|favicon.ico|icons|sw\\.js|manifest\\.json|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.webp$|.*\\.ico$|.*\\.woff2?$|.*\\.ttf$|.*\\.otf$).*)",
  ],
};
