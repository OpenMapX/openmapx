import type { PublicShare } from "@openmapx/core";
import { serverApiUrl } from "@openmapx/core/server-api";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";
import { SharedViewClient } from "./SharedViewClient";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

type LoadResult =
  | { status: "ok"; share: PublicShare }
  | { status: "not-found" }
  | { status: "unavailable" };

/**
 * One fetch per request (React `cache` dedupes page + metadata). Deliberately
 * cookie-free and `no-store`: the response is anonymous-public and revocation
 * must be immediate.
 */
const loadShare = cache(async (token: string): Promise<LoadResult> => {
  if (!TOKEN_RE.test(token)) return { status: "not-found" };
  try {
    const res = await fetch(`${serverApiUrl()}/api/shares/${token}`, { cache: "no-store" });
    if (res.status === 404) return { status: "not-found" };
    if (!res.ok) return { status: "unavailable" };
    return { status: "ok", share: (await res.json()) as PublicShare };
  } catch {
    return { status: "unavailable" };
  }
});

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
  const name = result.share.name.startsWith("$")
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
