# App Review notes — Apple

Paste into App Store Connect → App Review Information. No credential goes in
this file; reviewer credentials, if any are ever needed, are entered directly in
App Store Connect. The text below is what gets pasted.

**No account is required.** Search, directions and full turn-by-turn navigation
all work signed out. There is nothing to log into to review this app.

**The interface is a web app inside a WebView, and that is deliberate.** The
same interface runs at https://openmapx.com. What the native code provides is
everything a browser cannot do:

- Background location, so guidance continues with the screen locked.
- The navigation engine itself — progress along the route, off-route detection,
  and cue timing — running headlessly, so it keeps working when the WebView is
  suspended or killed.
- A native SQLite session, so a trip survives a crash or a process restart.
- Audio focus and speech, so directions are spoken over other audio.
- Locally scheduled alerts for public transport, so a rider is woken before
  their stop with no network and no push service.
- Verified link handling and the recovery UI shown when the page cannot load.

The WebView is restricted to one compiled-in origin, enforced by both the
navigation allowlist and WebKit App-Bound Domains. There is no server picker.

**To see background location working:**

1. Open the app. No permission is requested at launch.
2. Search for any destination and choose Directions.
3. Tap Start. A full-screen disclosure explains that location is used in the
   background to keep guiding you while the screen is locked, that progress is
   computed on the device, and that you can choose foreground-only instead.
4. Accept, then grant the OS prompt.
5. Lock the screen. Guidance continues and speaks.
6. Return and tap End. Location stops immediately.

Choosing foreground-only at step 3 is fully supported: the app works and says
plainly that guidance pauses when the screen locks.

**Privacy.** Position while navigating is processed on the device and is not
transmitted. Coordinates leave the device only to compute a route the user asked
for, or a new one after they have left the route. There is no location history,
no analytics SDK, no crash reporter, and no advertising identifier.

**Sign-in.** Email, password, email OTP and two-factor all run in the app. OAuth
and passkeys open the system browser, per RFC 8252, because embedded user agents
are not a durable contract for either. No third-party provider is offered as a
way to create or enter an account on iOS; OpenStreetMap and Mapillary can only
be linked to an account that already exists.

**No remote code.** The app executes no downloadable native bundle and no
over-the-air update. Administrator-installed community integrations, which the
website supports, are disabled entirely in the app. The bridge between the page
and the native side speaks a fixed, versioned, schema-validated vocabulary — it
cannot invoke arbitrary native functionality.

**Offline, honestly.** A trip started while online continues through complete
loss of connectivity, including through the WebView being killed. A cold start
with no cached page cannot show the map, and the app says so rather than showing
a blank screen. The listing does not claim offline maps.

**Force quit** ends guidance. iOS does not relaunch the app for us and the app
does not pretend otherwise.
