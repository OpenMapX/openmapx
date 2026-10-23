# Review notes and declarations: Google Play

<a id="review-notes-and-declarations--google-play"></a>

Preparation status: **not ready to submit**. The current foreground shell has no
native navigation/auth dispatcher and advertises no navigation capabilities.
Signing identities are placeholders and no physical beta reports are committed.
Complete composition, artifact inspection and beta qualification before supplying
declarations or reviewer steps.

## Background location declaration

Before entering a declaration in Play Console, confirm the exact candidate:

- Uses background location only for a navigation session the user starts.
- Stops tracking on End and arrival.
- Offers foreground-only use with its background limitation explained.
- Processes progress on the device and transmits position only for the declared
  route/reroute/replan flows.
- Keeps the disclosure, purpose strings, privacy policy, listing, video and
  console answers consistent with the actual behavior.

The generated `compliance/background-location-declaration.md` describes intended
navigation behavior. Its existence does not establish that the installed app
implements it. Review the data-practice registry and generated worksheets against
the candidate before transcribing them.

## Foreground service

The reviewed Android service type is `location`. On a qualified build, verify
that an explicit Start creates the ongoing notification and that End/arrival
stops the service and removes it. Test the Android 14+ foreground-start restriction
and notification-permission denial separately. Do not infer service behavior from
manifest declarations alone.

## The in-app prominent disclosure

Verify the disclosure appears before the OS prompt, explains background use and
on-device progress, describes route-request transmission, and offers a clear
foreground-only choice and End control. Record grant and denial paths. Use the
actual localized copy from the candidate in submission material; do not maintain
a separately paraphrased permission promise here.

## Data safety

Use `compliance/data-practices.json` and
`compliance/google-data-safety-worksheet.md` as preparation inputs. The account
holder must confirm current console categories and collection/sharing/retention
answers against actual app and server behavior. Check the public deletion page at
`https://openmapx.com/delete-account` from an external network without signing in.

## App access

Verify browsing, search and the qualified navigation flow while signed out.
Account-specific features may require sign-in. Enter any reviewer credentials
directly in Play Console, never in the repository.

## Reviewer steps

Test these on the exact candidate before providing them:

1. Open the app; confirm no permission request at launch.
2. Search a public destination, choose Directions and tap Start.
3. Read the disclosure, test the grant/denial choices and OS permission flow.
4. Minimize and lock the device; record actual guidance and the ongoing
   notification.
5. Return and tap End; confirm location, alerts and the notification stop.

Record physical OS/callback/audio limitations. Do not describe unrun steps as
working behavior.

## Other declarations

Confirm ads, target audience, content rating and production-access testing in the
actual console. The repository does not establish completion of those forms.
Prepare the video using `background-location-video-script.md` only after the
flow is implemented and qualified.
