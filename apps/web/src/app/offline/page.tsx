import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { OfflineActions } from "./OfflineActions";

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("offline");
  return {
    title: `${t("pageTitle")} · OpenMapX`,
    description: t("pageDescription"),
    robots: { index: false, follow: false },
  };
}

export default async function OfflinePage() {
  const t = await getTranslations("offline");

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--omx-teal-light)] text-[var(--omx-teal)]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <title>Offline</title>
            <path d="M2 2l20 20" />
            <path d="M8.5 16.5a5 5 0 017 0" />
            <path d="M2 8.82a15 15 0 014.17-2.65" />
            <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
            <path d="M16.85 11.25a10 10 0 015.15 1.5" />
            <path d="M5 13.06a10 10 0 015.17-1.46" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>

        <h1 className="mb-3 text-2xl font-semibold tracking-tight">{t("pageTitle")}</h1>
        <p className="mb-8 text-sm text-[var(--omx-overlay-text)] opacity-70">
          {t("pageDescription")}
        </p>

        <div className="mb-8 rounded-lg bg-[var(--omx-overlay-bg)] p-4 text-left text-sm shadow-sm ring-1 ring-[var(--omx-border-light)]">
          <h2 className="mb-2 font-medium">{t("stillWorks")}</h2>
          <ul className="space-y-1.5 opacity-80">
            <li>• {t("stillWorksTiles")}</li>
            <li>• {t("stillWorksRoutes")}</li>
            <li>• {t("stillWorksDownloaded")}</li>
          </ul>
        </div>

        <OfflineActions retryLabel={t("retry")} openMapLabel={t("openMap")} />
      </div>
    </main>
  );
}
