import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "mapillary-js/dist/mapillary.css";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/classic.css";
import "./globals.css";
import { Providers } from "./providers";

const plusJakartaSans = Plus_Jakarta_Sans({
  weight: ["300", "400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenMapX",
  description: "Open-data maps — a Google Maps alternative",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={plusJakartaSans.variable} suppressHydrationWarning>
      <body className="h-dvh overflow-hidden antialiased">
        <InitColorSchemeScript attribute="class" defaultMode="system" />
        <AppRouterCacheProvider>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <Providers>{children}</Providers>
          </NextIntlClientProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
