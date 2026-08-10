<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     change the registry and regenerate, so the policy, the labels and the code
     keep saying the same thing. -->

# Google Play Data safety worksheet

Transcribe into Play Console → App content → Data safety. As with Apple, the
account holder confirms each answer against the current official form.

## Collected and shared

| Category | What | Sharing | Handling | Required | Purposes |
| --- | --- | --- | --- | --- | --- |
| Location | Start, destination and waypoint coordinates | Collected only | Processed ephemerally | Required | App functionality |
| Location | Current position, sent once when a reroute or replan is needed | Collected only | Processed ephemerally | Required | App functionality |
| Location | Transit origin, destination, departure time, and a rotating refresh token | Collected only | Processed ephemerally | Required | App functionality |
| Personal info | Email address, display name, and authentication credentials | Collected only | Retained | Optional | Account management, App functionality |
| App activity | Saved places, labels, and app preferences | Collected only | Retained | Optional | App functionality |
| App activity | Review signing key material | Collected only | Retained | Optional | App functionality |
| App activity | Review text and rating the user chooses to publish | Shared | Retained | Optional | App functionality |
| Location | Tile and imagery requests, which reveal the area being viewed | Shared | Processed ephemerally | Required | App functionality |

## Security practices

- All transmission is over HTTPS.
- Users can request deletion in the app and at a public URL that works after
  uninstall: `https://openmapx.com/delete-account`.
- The app has been reviewed against these answers rather than the answers being
  written from the app's description.

## Data not collected

Location used for navigation is processed on the device and is not collected.
The stop lists captured before a transit journey, the local alert schedule, the
diagnostics buffer, and the WebView's own storage all stay on the device.

## Location permission declaration

Background location is used **only during an active navigation session the user
started**, to continue turn-by-turn or transit guidance while the screen is
locked. It is not used for advertising, analytics, or any form of tracking, and
the app works without it in foreground-only mode.
