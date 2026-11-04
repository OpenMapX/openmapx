import type { AndroidManifestLike } from "./nativeConfigTransforms.ts";
export const CAR_PERMISSIONS = [
  "androidx.car.app.NAVIGATION_TEMPLATES",
  "androidx.car.app.ACCESS_SURFACE",
] as const;
/** Library manifest owns the services/resources; the host declares its compiled origin and permissions. */
export function applyCarConfig(manifest: AndroidManifestLike, origin: string): AndroidManifestLike {
  const existing = manifest.manifest["uses-permission"] ?? [];
  const permissions = [
    ...existing,
    ...CAR_PERMISSIONS.filter(
      (name) => !existing.some((node) => node.$["android:name"] === name),
    ).map((name) => ({ $: { "android:name": name } })),
  ];
  return {
    ...manifest,
    manifest: {
      ...manifest.manifest,
      "uses-permission": permissions,
      application: manifest.manifest.application?.map((app) => ({
        ...app,
        activity: (
          app.activity as
            | Array<{ $: Record<string, string>; "intent-filter"?: Array<Record<string, unknown>> }>
            | undefined
        )?.map((activity) => {
          if (!activity.$["android:name"]?.endsWith("MainActivity")) return activity;
          const filters = activity["intent-filter"] ?? [];
          const additional = ["geo", "google.navigation"]
            .filter(
              (scheme) => !filters.some((filter) => JSON.stringify(filter).includes(`"${scheme}"`)),
            )
            .map((scheme) => ({
              action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
              category: [
                { $: { "android:name": "android.intent.category.DEFAULT" } },
                { $: { "android:name": "android.intent.category.BROWSABLE" } },
              ],
              data: [{ $: { "android:scheme": scheme } }],
            }));
          return { ...activity, "intent-filter": [...filters, ...additional] };
        }),
        "meta-data": [
          ...((app["meta-data"] ?? []) as Array<{ $: Record<string, string> }>).filter(
            (node) => node.$["android:name"] !== "org.openmapx.androidauto.WEB_ORIGIN",
          ),
          { $: { "android:name": "org.openmapx.androidauto.WEB_ORIGIN", "android:value": origin } },
        ],
      })),
    },
  };
}
