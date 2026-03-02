import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-AppRouter";
import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { Providers } from "./providers";

const roboto = Roboto({
  weight: ["300", "400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-roboto",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenMapX",
  description: "Open-data maps — a Google Maps alternative",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={roboto.variable}>
      <body className="h-dvh overflow-hidden antialiased">
        <AppRouterCacheProvider>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
