import { isSystemSavedList } from "@openmapx/core/saved-lists";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";
import { loadPublicShare } from "@/lib/loadPublicShare";
import { SharedViewClient } from "./SharedViewClient";

/** One acquisition per render request; neither data nor bearer token enters a persistent cache. */
const loadShare = cache(loadPublicShare);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const result = await loadShare(token);
  const t = await getTranslations("share");
  const tSaved = await getTranslations("saved");
  const base: Metadata = { robots: { index: false, follow: false } };
  if (result.status !== "ok") return { ...base, title: "OpenMapX" };
  if (result.share.type === "route") {
    return { ...base, title: `${t("sharedRoute")} · OpenMapX` };
  }
  const name = isSystemSavedList(result.share.name)
    ? tSaved(result.share.name.slice(1))
    : result.share.name;
  return {
    ...base,
    title: `${name} · OpenMapX`,
    description: t("places", { count: result.share.places.length }),
  };
}

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await loadShare(token);
  if (result.status === "not-found") notFound();
  return <SharedViewClient share={result.status === "ok" ? result.share : null} />;
}
