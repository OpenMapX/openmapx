import { type NextRequest, NextResponse } from "next/server";
import { defaultLocale, type Locale, locales } from "./i18n/config";

export function middleware(request: NextRequest) {
  const cookieLocale = request.cookies.get("NEXT_LOCALE")?.value;

  if (cookieLocale && locales.includes(cookieLocale as Locale)) {
    return NextResponse.next();
  }

  const acceptLang = request.headers.get("accept-language") ?? "";
  const preferred = acceptLang
    .split(",")
    .map((part) => part.split(";")[0].trim().split("-")[0])
    .find((lang) => locales.includes(lang as Locale));

  const locale = preferred ?? defaultLocale;

  const response = NextResponse.next();
  response.cookies.set("NEXT_LOCALE", locale, {
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    sameSite: "lax",
  });
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|api|favicon.ico|icons|sw\\.js|manifest\\.json|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.webp$|.*\\.ico$|.*\\.woff2?$|.*\\.ttf$|.*\\.otf$).*)",
  ],
};
