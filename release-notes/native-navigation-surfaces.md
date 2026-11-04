# Native navigation on the lock screen

Product impact: operator-action

Installed OpenMapX apps can show ongoing ground and transit guidance through an
Android navigation notification or an iOS Live Activity, with session-bound native
End confirmation. The cards follow the durable native session and do not require
an active WebView. Availability, promotion, privacy and background updates remain
subject to OS permissions and runtime policies.

Ship the updated web app and rebuilt native binaries together so native End also
clears the web guidance screen. Android requests the non-runtime
POST_PROMOTED_NOTIFICATIONS permission. Apple distribution additionally requires
registering/provisioning the derived `.NavigationSurface` extension App ID; no
remote push entitlement or service is required.
