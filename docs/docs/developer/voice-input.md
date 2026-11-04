---
title: On-device voice input
description: Native voice search decisions, microphone isolation, bridge contract and pending device qualification.
---

# On-device voice input

The installed app uses the existing search microphone button and warning snackbar.
Interim transcripts fill the search field.
The final transcript submits through ordinary search, as on the website.
This page records the native design; device qualification remains open.
The website continues to use browser speech recognition, whose processing may use a vendor's servers.

## Recogniser decision

The native dependency is `expo-speech-recognition` **57.1.1**, licensed under MIT and maintained by jamsch.
It is a community package, not an official Expo package.
It wraps Android's `SpeechRecognizer` and Apple's `SFSpeechRecognizer` rather than bundling a separate engine.

| Alternative                      | Reason for rejection                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@react-native-voice/voice`      | Archived; does not provide the required strict on-device guarantee.                                 |
| Vosk or whisper-based packages   | Separate engines with large models rather than the OS recogniser requested for this feature.        |
| Newer speech wrappers considered | Missing cancellation or final-result flags needed for lifecycle ownership and automatic submission. |

The existing mobile dependency inventory reports package licences but does not distribute licence notices.
The web notice generator does not scan `apps/mobile`.
A mobile distribution notice for this MIT dependency remains a release gap; no new notice mechanism is introduced here.

## Android guarantee and language readiness

On Android, voice input is enabled only on Android 13 or later (API 33+) with an available on-device service.
Every recognition request sets `requiresOnDeviceRecognition: true`.
On this path the pinned package calls `SpeechRecognizer.createOnDeviceSpeechRecognizer`, with no network recogniser fallback.
OpenMapX never sets `androidRecognitionServicePackage`.
On API 31–32 the package would only prefer offline recognition, so the capability stays off there.
Downloading a model requires a network connection; recognition itself does not.
This guarantee concerns recognition, not the subsequent search request.

The web button requests a BCP-47 locale using the matching navigator region, or `en-US` / `de-DE` defaults.
Native readiness checks the on-device service's installed locales on each start.
It selects an exact match, then the first installed locale with the same primary language.
If neither exists, it returns `language-not-supported` and uses the existing warning that offline speech for this language is not installed.
It triggers Android's model download once per requested locale per app run.
Android owns the download dialog on API 33 and the background download on API 34+.
A download request is not proof that installation succeeded; the next start checks again.

## iOS on-device guarantee

Our committed pnpm patch for `expo-speech-recognition@57.1.1` closes upstream
[jamsch/expo-speech-recognition#169](https://github.com/jamsch/expo-speech-recognition/issues/169).
Before constructing the native recognizer, start checks the requested locale's
recognizer for existence, availability and on-device support. The recognizer
rechecks these conditions before preparing a request or activating the audio session.
Failure emits `language-not-supported` and `end`, without capture. Every request
unconditionally sets `requiresOnDeviceRecognition` before `recognitionTask`;
contextual strings, task hints and punctuation never change that flag.
Apple warns that the flag is honored only when
[`supportsOnDeviceRecognition` is true](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition).
There is no server fallback or iOS model-download trigger.

The patched synchronous availability API accepts an optional locale. Its JS wrapper
passes this argument only on iOS, preserving Android's zero-argument API.
The voice probe checks `de-DE`, `en-US` and `en-GB`; one supported locale enables it.
Start checks the requested locale first, then candidates with the same primary language.
iOS `getSupportedLocales` is not an installed-model inventory and is not used.
Readiness can still change after probing; the native guards enforce the boundary again.

OpenMapX conservatively checks and, when askable, requests both microphone and
speech-recognition authorization, mapping either denial to `not-allowed`.
The package skips its speech-authorization guard for on-device requests, while
[Apple's authorization guidance](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)
does not explicitly exempt this path. We therefore do not rely on that omission.
System permission alerts can make the app inactive; `suspend()` exempts prompts
and start waits for active state before capture. Both usage strings are localized.

iOS words the Speech Recognition alert itself: "Speech data from this app will be
sent to Apple to process your requests. This will also help Apple improve its speech
recognition technology." Our usage string follows it. That system text is the same
for every app and does not reflect `requiresOnDeviceRecognition`, so it contradicts
the on-device guarantee. If a real iPhone shows that on-device recognition works
without speech-recognition authorization, the controller should stop requesting it
so this alert never appears; until then it is requested.

The existing warning points to iPhone Privacy & Security settings for permissions.
For missing offline language support it suggests Settings > General > Keyboard,
adding the language's keyboard and enabling Dictation, following Apple's
[Dictation](https://support.apple.com/guide/iphone/iph2c0651d2/ios) and
[keyboard](https://support.apple.com/guide/iphone/iph73b71eb/ios) guides.
This is setup guidance, not a promise that a model becomes available on every iPhone.

Recognition explicitly uses `playAndRecord` / `measurement` with `defaultToSpeaker`
and `allowBluetooth`, matching package defaults without ducking options.
After native end (or bounded abort settlement), the arbiter checks guidance status
and deactivates with `notifyOthersOnDeactivation` unless guidance is speaking.
Only then does it release a held cue, whose native module configures `playback` /
`voicePrompt` itself. The lease stays owned until hand-back completes.

Installed-source mutation tests and the release gate verify the two guards and
unconditional request flag. Controller/arbiter tests cover locale selection,
permissions, prompt inactivity and hand-back ordering. The existing SwiftPM runner
compiles navigation audio policy only; duplicating recognizer policy in that module
would not exercise the patched dependency. No native recognizer execution or iPhone
privacy/device qualification is claimed by these structural and JavaScript checks.

On an iOS 26.4 simulator, a debug build of this design showed the voice button
(the simulator reports on-device support for `en-US` only), the microphone and
Speech Recognition alerts with our usage strings, the iPhone wording for a refused
permission, and the iPhone wording for German without recording or a prompt.
Recording itself was not exercised: without host microphone access the simulator's
audio input times out and the package aborts the app while opening the input node,
which does not occur on a device with a microphone. The app does not start on the
iOS 27 simulator at all, independent of voice input: apps built with the iOS 27 SDK
must adopt the scene-based life cycle, which the generated `AppDelegate` does not yet.

## Permission and lifecycle

The first microphone tap requests Android's `RECORD_AUDIO` permission through the OS prompt.
Android shows that prompt as a separate activity, which reports the app as backgrounded.
The prompt therefore does not cancel the session; once it closes, the session waits up to two seconds for the app to return to the foreground before it starts listening.
A denial uses the existing snackbar directing the user to Android settings.
There is no custom rationale dialog or settings button, in keeping with the no-new-UI constraint.

Each session owns one utterance, with continuous recognition disabled and a 15-second listening cap.
Tapping the listening button sends stop, which permits a final result.
Stop has a three-second terminal-event deadline, followed by a quiet abort if no final result arrives.
After an abort or a recogniser error, the session waits up to three seconds for Android's end event.
If it never arrives, the session finishes anyway, removing its listeners and releasing the guidance hold.
Such a session stays unconfirmed, because recogniser events carry no request ID.
The next start aborts it again and waits up to three seconds for its end or error; without one it answers `busy` rather than attach new listeners that could receive the old recogniser's output.
Cancellation discards results on backgrounding, screen off, page reload, document replacement, channel loss, load failure, a new start or app teardown.
Native ownership includes the document channel and `requestId`.
Both sides discard late results after ownership ends.
Voice events are never queued or replayed into a replacement document.

## Guidance audio coordination

Listening waits for a guidance utterance already in progress, for at most six seconds.
After that deadline, guidance is stopped before recognition starts.
While listening, the audio arbiter holds guidance cues and keeps only the latest.
When listening ends, it speaks that cue only if it is at most ten seconds old.
Older cues are dropped with a stable outcome, so stale directions are not spoken.
Foreground and headless navigation speech in the same runtime use this arbiter.

## WebView isolation

The WebView never receives microphone access.
The web shell descriptor keeps `shellFeatureBoundary().microphone` false, including before bridge negotiation.
iOS uses `mediaCapturePermissionGrantType="deny"`.
The Android `react-native-webview` patch denies both audio and video capture without requesting an OS grant.
The native recogniser owns the microphone; only transcript text crosses into the page.

## Bridge and rollout

Protocol v3 is unchanged.
After a compatible handshake, web sends `voice.probe` with strict empty payload `{}`.
Native replies with strict `voice.availability` payload `{ forMessageId, available: boolean }`,
correlated to the probe's envelope message ID. The web button stays hidden until a true reply;
false, rejection or the default five-second read deadline keeps it hidden.
A new client or renegotiated handshake probes again. Ordinary websites never probe.

Neither hello payload changes: deployed web and APK parsers are strict, so even an optional
new capability key would break negotiation. New APK + old web keeps navigation working
because hello is unchanged and old web never probes. Old APK + new web silently rejects
the unknown probe before deduplication or dispatch (`NativeBridge.receive` on `origin/main`);
the unanswered probe times out without changing navigation state. Protocol version stays unchanged.
A web deployment can precede the APK because an unanswered probe only hides voice input.
The current parser accepts `voice.probe`, so the old-parser rejection is verified against
`origin/main` source rather than asserted against the new parser in a unit test.
There is no browser-recognition fallback inside the shell.

| Direction    | Message              | Payload                                              |
| ------------ | -------------------- | ---------------------------------------------------- |
| Web → native | `voice.probe`        | Strict empty object; correlated availability request |
| Native → web | `voice.availability` | `forMessageId`, boolean `available`                  |
| Web → native | `voice.start`        | `requestId`, BCP-47 `locale` (at most 35 characters) |
| Web → native | `voice.stop`         | `requestId`; finish and allow a final result         |
| Web → native | `voice.cancel`       | `requestId`; abort and discard results               |
| Native → web | `voice.event`        | `requestId`, `state`, optional `text` or `error`     |

Start, stop and cancel use `send` without a correlated reply; the probe uses `request`.
Events use subscription broadcasts with strict schemas.
States are `listening`, `partial`, `final`, `ended` and `error`.
Only `partial` and `final` may carry text, bounded to 512 characters.
Error codes are `not-allowed`, `language-not-supported`, `no-speech`, `audio-capture`, `busy`, `unavailable`, `aborted` and `generic`.
`NativeVoiceInput` creates a new request ID per utterance, unsubscribes on cancellation and rejects foreign or late events.

## Privacy

Audio is processed on the device by the OS recogniser.
OpenMapX does not transmit or store audio; `recordingOptions.persist` is false.
Transcripts are not logged.
The transcript becomes ordinary search text and follows the normal search-request and search-history rules.
The compliance registry separates this local audio practice (`voice-search-audio`) from subsequent search data flows.

The page cannot start the microphone on its own.
The shell accepts `voice.start` only within three seconds of a touch it observed itself on the screen, and each touch admits one start.
A script injected into the page therefore cannot listen in a loop.
With a screen reader on, activation arrives as an accessibility action rather than a touch, so the touch requirement is waived there.
A refused start answers `voice.event` with `error: "generic"` and records nothing.
Android's own microphone indicator shows whenever the recogniser holds the microphone, and the page cannot hide it.

## Open verification

Source and unit checks do not establish installed-device behavior.
Before qualifying a candidate, test airplane-mode recognition with installed models and German and English place names.
Cover missing models, download completion, permission grant, denial, permanent denial and revocation.
Check microphone release after stop, cancellation, backgrounding, screen off, page replacement and teardown.
Verify guidance hold/release, stale-cue dropping and WebView capture denial on the candidate binary.
Measure accuracy and latency separately on a consented recording set; no such measurement is claimed here.
