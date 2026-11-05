# Native sharing and file intake qualification

Dates: 2026-11-04–2026-11-05. Development identity `org.openmapx.intake.dev`, scheme `openmapx-intake-dev`. Source/build checks and runtime observations are separate; this is not store-release acceptance.

## Automated evidence

- Repository CI passed all five required checks on `24753090a`, before the final runtime corrections. Earlier local full verification passed 2,023 test files / 24,916 tests. Subsequent full attempts could not acquire the shared verification lock; they are not passes.
- Final runtime candidate: 83 mobile Jest suites / 1,409 tests passed, plus mobile types and all three web package TypeScript configurations. Ten focused protocol, bridge, parser and native-config suites passed 225 tests; after the privacy corrections, five affected suites passed 156 tests. These sets overlap.
- SwiftPM passed 22 tests: inbox persistence, limits, immutable chunks, combined share selection, source authority, bounded descriptor reads, symlink/FIFO replacement, scope denial/release, cancellation/timeout, background-task expiry and both privacy manifests. Injected scope/coordinator tests do not establish real OS grants.
- Android debug APK and 18 intake JVM tests passed. Earlier all four native JVM suites passed 67 tests. Robolectric does not implement real pipe polling; the emulator provider checks below supply that evidence.
- iOS Simulator Debug and Release host plus navigation/share extensions built successfully. The Release build embeds JavaScript and includes the final privacy resources; it was used for cold Files delivery.
- Two clean HTTPS native generations agreed. Generated-surface, reviewed permissions, dependency inventory, installed WebView capture/document-start policy and headless-bundle checks passed. No generated project is tracked. Formatting and affected package types passed.

## Observed runtime behavior

| Platform / sender                     | Observed result                                                                                                                                                                                                                       | Boundary                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Android API 36.1, separate QA app     | Real OS sharing of address/map text and GPX, GeoJSON and KML from a foreign pipe-backed provider reached preview; explicit Open/import/replacement completed. Direct `content:` GPX VIEW also reached review and overlay replacement. | The controlled sender is a real native app/provider, not Drive or Gmail.                                                         |
| Android, rebuilt document-start patch | Repeated text → GeoJSON share → GPX document VIEW → KML share completed without the earlier channel invalidation. History changes retained a usable bridge.                                                                           | No claim about every WebView version or the separate fast consecutive real-load nonce-prop race.                                 |
| Android negative cases                | A provider reporting a false small size but delivering over 5 MiB was rejected with the limit message. Mixed GPX/PDF produced the unsupported-content message. Neither offered Import.                                                | Hung/cloud-provider cancellation still needs provider/device qualification.                                                      |
| Android load failure/retry            | Loss of the owned port forwarding produced the native connection-error screen. Restoring forwarding and pressing Try again restored the map and delivered the pending oversized-file error.                                           | Error-screen stability and successful retry observed; exact callback ordering for every Chromium error page remains unqualified. |
| iOS 27, separate QA app               | Real Share Extension Add → saved confirmation → Done → manual host open worked for text and all three formats. GeoJSON was repeated after the shared descriptor-reader change and imported successfully.                              | No unsupported automatic host launch.                                                                                            |
| iOS 27 Files, warm host               | A real 197-byte GPX saved On My iPhone appeared in Files Open With, launched the host, reached GPX review, and imported the map overlay.                                                                                              | Local Files provider, not iCloud/third-party cloud.                                                                              |
| iOS 27 Files, stopped host            | With the Simulator Release binary installed and host stopped, Files Quick Look → OpenMapX Dev launched the host, produced one GPX preview and imported it. The Files original remained present at 197 bytes.                          | Simulator local ad-hoc signing; no physical-device or production provisioning claim.                                             |
| Browser, 390 × 844                    | Busy-native transport fixture disabled Import with the deferred explanation.                                                                                                                                                          | Rendering proof only; actual active-trip deferral remains unqualified.                                                           |

PR screenshots are actual native preview/import surfaces on both platforms, plus the iOS Share Extension. The deferred-state screenshot is explicitly a browser fixture. Final additional captures show iOS cold Files preview/import and Android KML preview/import. Images are unedited. QA senders and a transparent local development proxy lived outside the repository; no shipped test entry points, fixture transport or input-code injection was used for native receiving.

## Runtime corrections and limits

A callback trace showed Android history callbacks reporting `loading=true` after page finish without a new `onPageStarted`. Progress was therefore not a safe document identity signal. The pinned WebView patch now tags true document starts before bootstrap injection; history still reaches back/navigation state but cannot reset the channel. Missing tags fail closed. No late-descriptor bootstrap fallback, marker or origin relaxation was added. Temporary callback diagnostics were removed before rebuilding.

An A/B Files experiment showed that `LSSupportsOpeningDocumentsInPlace=false` hid OpenMapX from Open With on iOS 27. The final registration is true. Only OS-delivered URLs with a positive security-scope grant enter the bounded host reader; the original is never mutated. Existing non-in-place Inbox copies retain separate strict handling. The app container is not exposed through file sharing or a document browser.

During qualification, one Android command reported an adb timeout. Its prescribed server restart and one retry recovered automation; port forwarding was restored. An iOS debug cold start lacked its Metro bundle URL, so cold Files acceptance was repeated successfully with embedded JavaScript in a Release Simulator build. These development-tool incidents are not counted as intake passes. Earlier automation failures were recovered in this later run.

Still unqualified: actual active-trip deferral; process-death/Recents replay including API 30 or lower; old-web inbox overflow on a device; real hung/cloud providers; Files, browser-download and Drive/Gmail MIME matrices; older-iOS registration; physical-device background behavior; production Apple team/App Group provisioning. Generic MIME filters have not been broadened without provider evidence. iOS policy-start handling for fragments/noncommitting navigations and fast real-load nonce-prop delivery remain separately documented lifecycle limits.

## Release prerequisites

Final Claude review approved the runtime corrections with no blocking correctness
or security findings. The expiration handler now ends its background assertion
synchronously when already on the main thread. Two low-severity limits remain:
the ten-second budget includes serial queue waiting, and cancellation racing the
final rename can produce a completed item alongside an unreadable notice. The
item remains reviewable; no source file is changed.

Deploy compatible web first; protocol 3 retains navigation and protocol 4 enables intake. Rebuild native apps. Register/provision `<appId>.ShareExtension` and `group.<appId>.intake` for host and Share Extension only; the navigation widget has no group. Simulator local ad-hoc signing does not establish Apple team, provisioning or App Store acceptance.

Local HTTP was used only for development runtime QA. Afterward, two clean HTTPS generations and reviewed generated-permission checks passed. The installed local-HTTP Simulator build is not a release transport artifact. Production signing and final release binaries still require their release gates.

## Share Extension theme correction

The extension now receives both palettes and the corner radius from the shared core theme through generated Info.plist metadata. It uses a top-aligned, scrollable layout, content-type/name summary, filled primary action, Dynamic Type and distinct saving/success/error presentation. The system appearance controls light/dark colors; no host theme preference or extra App Group data is read. The Simulator Release build was inspected in light, dark and accessibility-large text size. Add produced the success state and Done dismissed the extension. Native config/generated-policy tests passed 48 tests, mobile types and generated checks passed, and the host plus both extensions built. This visual revision was self-reviewed; the earlier Claude approval covers the preceding intake/runtime corrections.

## Final full-review corrections

Current Apple Maps unified place/search/frame URLs and Google Maps place/@ URLs now classify locally, preserving labels and coordinate bounds. No redirect following or network access was added. Bare short links remain unsupported; sender labels can still be searched. Regression cases include malformed paths and out-of-range coordinates.

Intake distinguishes unavailable native navigation authority from an active session. Normal startup/session-read failure returns a correlated `navigation-unavailable` error using the existing bridge error envelope, retains owned items and prevents application/acknowledgement. The web shows explicit reopen/recheck guidance instead of claiming an active trip. Feasibility builds deliberately skip the normal navigation composition and permit intake. Tests cover idle/active/startup failure/storage failure/feasibility and web recovery without applying or deleting items. No protocol-version or strict hello/listing schema changed. The new error notice is covered by component rendering/interaction tests and an actual browser rendering using a temporary protocol-4 bridge fixture; it has not been requalified on a native device.

Verification for the full-review corrections: 83 mobile suites / 1,414 tests, 4 focused web/core suites / 92 tests, mobile types and all three web TypeScript configurations passed. New regressions were also run against the old classifier/App/handler behavior and failed as intended. The App suite was repeated after awaiting asynchronous test teardown (73 tests passed).

Claude re-review confirmed both original issues were addressed and identified two follow-up regressions. These were fixed: Google route viewports are not place pins and search terms survive trailing viewports; empty inboxes skip trip-authority checks, while generic listing failures only show a notice for known shared items. A final import check reports an item missing from an empty inbox as expired rather than trip-deferred. New tests failed before these corrections and passed afterward. Final mobile verification passed 83 suites / 1,416 tests. The focused web/core suite and package types were repeated for the final candidate.

Final follow-up verification: 4 focused web/core suites / 99 tests passed. The unavailable-authority notice was rendered and inspected at 390 × 844 using a temporary browser-only bridge fixture; it remains below the search controls and uses the application theme. This is web presentation evidence, not native failure injection or native delivery evidence. The fixture and screenshot tooling stayed outside the repository.
