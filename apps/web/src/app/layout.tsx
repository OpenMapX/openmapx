import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-AppRouter";
import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "mapillary-js/dist/mapillary.css";
import "maplibre-gl/dist/maplibre-gl.css";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={plusJakartaSans.variable}>
      <body className="h-dvh overflow-hidden antialiased">
        <AppRouterCacheProvider>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
