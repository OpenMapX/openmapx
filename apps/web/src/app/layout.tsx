import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/virtual-tour-plugin/index.css";
import "maplibre-theme/icons.default.css";
import "maplibre-theme/classic.css";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";
import { headers } from "next/headers";
import { OfflineNotice } from "@/components/OfflineNotice";
import { FileOpenHandler } from "@/components/pwa/FileOpenHandler";
import { PersistentStorageRequest } from "@/components/pwa/PersistentStorageRequest";
import { SwUpdateNotice } from "@/components/pwa/SwUpdateNotice";
import { InstallPromptCapture } from "@/components/pwa/useInstallPrompt";
import { EnvProvider } from "@/lib/EnvProvider";
import { buildClientEnv } from "@/lib/env";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "OpenMapX",
  description: "Self-hostable, open-data maps — search, directions, and transit",
  applicationName: "OpenMapX",
  appleWebApp: {
    capable: true,
    title: "OpenMapX",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icons/app/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/app/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/app/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/app/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#207E23" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1c1c" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const clientEnv = buildClientEnv();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="/fonts/material-icons.css" />
      </head>
      <body className="h-dvh overflow-hidden antialiased">
        <InitColorSchemeScript attribute="class" defaultMode="system" nonce={nonce} />
        <AppRouterCacheProvider>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <EnvProvider config={clientEnv}>
              <Providers>
                {children}
                {/* Mounted at the root so the SW registers, the offline
                    notice surfaces on every route, and the install-prompt
                    listener attaches before `beforeinstallprompt` fires (it
                    would be missed if it lived inside the HamburgerMenu's
                    temporary Drawer subtree). Each component is a client
                    island with its own production / serviceWorker guards. */}
                <OfflineNotice />
                <SwUpdateNotice />
                <InstallPromptCapture />
                <PersistentStorageRequest />
                <FileOpenHandler />
              </Providers>
            </EnvProvider>
          </NextIntlClientProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
