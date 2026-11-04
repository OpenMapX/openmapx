# Native sharing and file intake qualification

Dates: 2026-11-04–2026-11-05. Development identity `org.openmapx.intake.dev`, scheme
`openmapx-intake-dev`. This records source/build and runtime evidence separately.
It is not store-release acceptance.

## Automated evidence

- Full repository verification passed: 2,023 test files passed, 58 skipped;
  24,916 tests passed, 277 skipped. This includes lint, types, policy and OpenAPI
  gates. Later focused checks cover the final intake changes.
- After merging Android Auto from main, mobile Jest: 80 suites / 1,344 tests passed.
- Earlier web bridge/PWA/parser checks: 21 suites / 258 tests passed. After review,
  3 focused preview/transfer/parser suites passed 24 tests, including refresh-stable
  drafts, navigation-start races, settings routing, chunks and the deadline.
- After merging Android Auto, core/config checks: 6 suites / 160 tests passed;
  web bridge/intake/car checks: 6 suites / 74 tests passed. The shell advertises
  both new capabilities to protocol-4 peers and omits them from older strict
  protocol-3 hello replies. The intake UI stays outside the car surface.
- SwiftPM inbox and share selection: 12 tests passed, covering restart, explicit
  completion, limits, expiry, document authority, staging age, concurrent writers, malformed metadata,
  actual file size, cancellation, chunk alignment, combined text/URL selection,
  mixed-file rejection and Apple’s GeoJSON type. The UTI test runs on the macOS
  host; it does not qualify registration on older iOS installations.
- Android inbox/policy/reader/receiver tests: 18 tests passed. The receiver tests
  cover Expo’s null-bundle path, neutral host intents, read-only grant forwarding,
  explicit repeated shares, clean root intents before grant forwarding and preview
  thumbnails on both text and single-file sharing. Robolectric uses temporary
  files for `createPipe` and does not implement `Os.poll/read`: the IO adapter tests verify
  descriptor ownership and deadlines; they do **not** qualify a real provider pipe.
- After merging Android Auto, the regenerated Android APK and all four native
  JVM suites passed (67 tests total). iOS Simulator host + navigation/share extension builds
  passed. Generated CNG policy, dependency inventory, headless bundle boundary and
  documentation build passed. No production provisioning/signing was attempted.

## Observed runtime behavior

| Surface                   | Evidence                                                                                                                                                                                                                             | Limit                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Android API 36.1 emulator | OpenMapX appears in the real OS text share sheet. Selecting it copied the owned QA sender's address into the private inbox before the review-driven receiver replacement.                                                            | Final dedicated receiver delivery, preview/application, cold receiving, file VIEW, real pipes, Recents and old-web overflow remain unqualified. |
| iOS 27 Simulator          | Host and external QA sender installed and launched.                                                                                                                                                                                  | Share Extension Add/manual handoff and cold Files Open In remain unqualified.                                                                   |
| Browser, 390 × 844        | Actual application preview rendered over the map using a temporary protocol-4 transport fixture. Explicit Import produced the overlay and a completion request. A busy-native fixture disabled Import with the deferred explanation. | This proves web rendering/flow, **not** native receiving or an actual active trip.                                                              |

The Android screenshot in the PR is a real OS share sheet from the pre-review
lifecycle-based receiver. The final dedicated receiver preserves registration,
but its delivery has not been visually requalified. Preview, imported
geometry and deferred-state screenshots are explicitly labeled browser fixtures.
No image was synthesized or edited. QA senders and the browser transport/proxy
lived outside the repository; there are no shipped test entry points.

## Device automation failures

Android's initial snapshot failed while the app was on its splash screen; its
prescribed retry succeeded. A later relaunch failed with “process remained running
after close”; the prescribed debug retry failed with “Android helper could not
launch the application”. Android UI work stopped without an adb UI fallback.

iOS's tap lost its XCTest transport response and invalidated the runner. The
prescribed startup recovery failed with “Daemon request timed out”. The device
hub screenshot request also failed; device inventory still showed the simulator
booted. iOS UI work stopped without a simctl UI fallback.

These are evidence limits, not passes. Before release, repeat native OS sharing
and document opening for all three formats on both platforms, cold and warm;
verify active-trip deferral, process-death/Recents replay, full inbox behavior,
foreign pipe-backed attachments and a hung-pipe deadline. Include a MIME/provider
matrix for Files, a browser download, and Drive or Gmail when available. Current
Android registration handles the geographic MIME types and text; generic MIME
fallbacks have not been broadened without provider evidence.

## Release prerequisites

Deploy compatible web first; protocol 3 retains navigation and protocol 4 enables
intake. Rebuild native apps. Register/provision `<appId>.ShareExtension` and
`group.<appId>.intake` for host + Share Extension only. The Simulator used local
ad-hoc signing for the group entitlement; this establishes no Apple team,
provisioning profile or App Store validation. The navigation widget has no group.

Local HTTP was used only for development QA. A release-permissions check correctly
rejected that cleartext development surface. The final HTTPS development surface
passed generated and reviewed-permission checks. Production signing and the
final release binary still require their release gates; local QA is not release transport-policy evidence.
