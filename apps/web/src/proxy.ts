import { type NextRequest, NextResponse } from "next/server";
import { type Locale, locales } from "./i18n/config";

export function proxy(request: NextRequest) {
  // If the user has explicitly chosen a language, respect it.
  const cookieLocale = request.cookies.get("NEXT_LOCALE")?.value;

  if (cookieLocale && locales.includes(cookieLocale as Locale)) {
    return NextResponse.next();
  }

  // Otherwise detect from Accept-Language header without setting a cookie.
  // The cookie is only set when the user explicitly switches language
  // (see setLocale.ts), keeping us compliant with TDDDG §25(2).
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|api|favicon.ico|icons|sw\\.js|manifest\\.json|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.webp$|.*\\.ico$|.*\\.woff2?$|.*\\.ttf$|.*\\.otf$).*)",
  ],
};
