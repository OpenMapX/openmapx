# Background-location video script

Record this only after foreground navigation composition and physical candidate
qualification. The current `src/App.tsx` cannot run the proposed Start flow. This
script is preparation material, not a recording or evidence of background use.

Use the exact signed candidate and frozen web build. Aim for about 90 seconds,
with captions readable long enough to understand each permission choice. Use a
public route between public places. Exclude home/work addresses, personal
accounts, unrelated notifications and debug overlays.

## Shots

1. Launch the app (about 5 seconds). Show that no permission request appears.
2. Plan a public route (about 15 seconds). Show the navigation mode being tested.
3. Tap Start and show the full disclosure (about 15 seconds), before the OS prompt.
4. Choose foreground-only (about 10 seconds). Show guidance, lock/unlock, then
   show its paused/limited state. This tests the limited choice; separately capture
   explicit denial if the console requires it.
5. End and start again (about 10 seconds). Grant background location through the
   platform's actual prompt or Settings route. Do not label an Android 11+ Settings
   transition as an in-app background-permission dialog.
6. Minimize and lock (about 20 seconds). Show the ongoing notification and record
   actual spoken guidance. Leave failed delivery visible in the test evidence and
   fix it before submission; do not add a success caption over a failure.
7. Return and tap End (about 15 seconds). Show the notification disappearing and
   verify tracking and alerts stop.

## Before publishing

- Inspect every frame for addresses, emails, credentials, tokens, notifications
  and debug output. Keep the source recording and its candidate identity privately.
- Confirm the video matches the declaration, disclosure and privacy policy.
- Use a host accepted by the current Play Console form. Do not assume a URL on
  the project site will be accepted. Review the final hosted video and access
  settings from an external session before submitting its link.
