export const TARGET = "OpenMapXShareExtension";
const TYPES = ["com.topografix.gpx", "public.geojson", "com.google.earth.kml"];
const MIMES = [
  "application/gpx+xml",
  "application/geo+json",
  "application/vnd.google-earth.kml+xml",
];
export function intakeAndroidFilters(): Array<{
  action: string;
  category: string[];
  data: Array<{ mimeType: string; scheme?: string }>;
}> {
  const geo = MIMES.map((mimeType) => ({ mimeType }));
  return [
    {
      action: "SEND",
      category: ["DEFAULT"],
      data: [...geo, { mimeType: "text/plain" }, { mimeType: "text/uri-list" }],
    },
    { action: "SEND_MULTIPLE", category: ["DEFAULT"], data: geo },
    { action: "VIEW", category: ["DEFAULT"], data: geo.map((d) => ({ ...d, scheme: "content" })) },
  ];
}
export function intakeImportedTypes() {
  return TYPES.map((UTTypeIdentifier, i) => ({
    UTTypeIdentifier,
    UTTypeDescription: ["GPX", "GeoJSON", "KML"][i],
    UTTypeConformsTo: [i === 1 ? "public.json" : "public.xml"],
    UTTypeTagSpecification: {
      "public.filename-extension": [["gpx"], ["geojson"], ["kml"]][i],
      "public.mime-type": [MIMES[i]],
    },
  }));
}
export function intakeDocumentTypes() {
  return [
    {
      CFBundleTypeName: "Geographic file",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Alternate",
      LSItemContentTypes: TYPES,
    },
  ];
}
export function intakeShareInfo(appId: string) {
  const geo = TYPES.map(
    (type) => `ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "${type}"`,
  ).join(" OR ");
  const text =
    '((ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.url" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.plain-text") AND NOT ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.file-url")';
  const rule = `extensionItems.@count == 1 AND SUBQUERY(extensionItems, $item, $item.attachments.@count >= 1 AND $item.attachments.@count <= 5 AND (SUBQUERY($item.attachments, $attachment, (${geo})).@count == $item.attachments.@count OR (SUBQUERY($item.attachments, $attachment, (${geo})).@count == 0 AND SUBQUERY($item.attachments, $attachment, ${text}).@count >= 1))).@count == 1`;
  return {
    CFBundleDisplayName: "OpenMapX",
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "XPC!",
    CFBundleShortVersionString: "$(MARKETING_VERSION)",
    CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
    OpenMapXIntakeAppGroup: `group.${appId}.intake`,
    UTImportedTypeDeclarations: intakeImportedTypes(),
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.share-services",
      NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).ShareViewController",
      NSExtensionAttributes: { NSExtensionActivationRule: rule },
    },
  };
}
export function shareBuildSettings(
  host: Record<string, unknown>,
  appId: string,
): Record<string, unknown> {
  return {
    PRODUCT_BUNDLE_IDENTIFIER: `"${appId}.ShareExtension"`,
    PRODUCT_NAME: `"${TARGET}"`,
    INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
    CODE_SIGN_ENTITLEMENTS: `"${TARGET}/ShareExtension.entitlements"`,
    IPHONEOS_DEPLOYMENT_TARGET: "16.4",
    CURRENT_PROJECT_VERSION: host.CURRENT_PROJECT_VERSION ?? "1",
    MARKETING_VERSION: host.MARKETING_VERSION ?? "1.0.0",
    ...(host.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: host.DEVELOPMENT_TEAM } : {}),
    CODE_SIGN_STYLE: "Automatic",
    SWIFT_VERSION: "5.0",
    APPLICATION_EXTENSION_API_ONLY: "YES",
    SKIP_INSTALL: "YES",
    TARGETED_DEVICE_FAMILY: '"1"',
    LD_RUNPATH_SEARCH_PATHS:
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    GENERATE_INFOPLIST_FILE: "NO",
  };
}

export const INTAKE_RECEIVER = "expo.modules.openmapxintake.IntakeReceiverActivity";
export function intakeReceiverDeclaration() {
  return {
    $: {
      "android:name": INTAKE_RECEIVER,
      "android:exported": "true" as const,
      "android:noHistory": "true",
      "android:excludeFromRecents": "true",
      "android:taskAffinity": "",
      "android:launchMode": "standard",
      "android:theme": "@android:style/Theme.Translucent.NoTitleBar",
    },
    "intent-filter": intakeAndroidFilters().map((f) => ({
      action: [{ $: { "android:name": `android.intent.action.${f.action}` } }],
      category: f.category.map((c) => ({ $: { "android:name": `android.intent.category.${c}` } })),
      data: f.data.map((d) => ({
        $: { "android:mimeType": d.mimeType, ...(d.scheme ? { "android:scheme": d.scheme } : {}) },
      })),
    })),
  };
}
