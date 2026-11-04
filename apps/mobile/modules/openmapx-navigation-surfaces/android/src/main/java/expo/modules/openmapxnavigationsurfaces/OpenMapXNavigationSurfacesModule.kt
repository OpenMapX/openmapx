package expo.modules.openmapxnavigationsurfaces

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

private const val PREFS = "openmapx.navigation.surface"
private const val CHANNEL = "openmapx-navigation-progress"
private val lock = Any()

class SurfaceDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    synchronized(lock) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val owner = intent.getStringExtra("owner") ?: return
      if (prefs.getString("owner", null) == owner && SurfacePolicy.userDismissedBeforeExpiry(System.currentTimeMillis(), intent.getLongExtra("staleAt", 0))) {
        prefs.edit().putString("dismissed", owner).apply()
        // Also remove an update that raced the swipe before this receiver ran.
        context.getSystemService(NotificationManager::class.java).cancel(SurfacePolicy.TAG, SurfacePolicy.ID)
      }
    }
  }
}

class OpenMapXNavigationSurfacesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenMapXNavigationSurfaces")
    AsyncFunction("updateAsync") { raw: String, scheme: String, _: Boolean ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      synchronized(lock) { update(context, raw, scheme) }
    }
    AsyncFunction("clearAsync") { expected: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      synchronized(lock) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (SurfacePolicy.canClear(prefs.getString("owner", null), expected)) {
          context.getSystemService(NotificationManager::class.java).cancel(SurfacePolicy.TAG, SurfacePolicy.ID)
          prefs.edit().remove("owner").remove("revision").apply()
        }
      }
    }
  }
  private fun update(context: Context, raw: String, scheme: String): Boolean {
    if (raw.toByteArray(Charsets.UTF_8).size > SurfacePolicy.MAX_BYTES || !scheme.matches(Regex("[a-z][a-z0-9+.-]{0,100}"))) return false
    val data = try { JSONObject(raw) } catch (_: Exception) { return false }
    val keys = setOf("version", "sessionId", "revision", "kind", "status", "title", "instruction", "detail", "compactText", "observedAtMs", "staleAtMs", "expiresAtMs", "locale", "eventAtMs")
    if (data.keys().asSequence().toSet() != keys || data.optInt("version") != 1) return false
    for (key in listOf("title", "instruction", "detail", "compactText")) {
      val text = data.opt(key) as? String ?: return false
      if (text.length > 160 || text.any { it.code < 32 }) return false
    }
    if (data.optString("kind") !in setOf("ground", "transit") || data.optString("status") !in setOf("active", "waiting", "stale", "arrived") || data.optString("locale") !in setOf("en", "de")) return false
    val owner = data.optString("sessionId")
    val revision = data.optLong("revision", -1)
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!SurfacePolicy.accepts(prefs.getString("owner", null), prefs.getLong("revision", -1), owner, revision)) return false
    if (prefs.getString("dismissed", null) == owner) return true
    val now = System.currentTimeMillis()
    val expires = data.optLong("expiresAtMs", 0)
    if (expires <= now) return false
    if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
    val manager = context.getSystemService(NotificationManager::class.java)
    if (!manager.areNotificationsEnabled()) return false
    val de = data.optString("locale") == "de"
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, if (de) "Navigationsfortschritt" else "Navigation progress", NotificationManager.IMPORTANCE_LOW))
    }
    fun action(path: String, request: Int): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.data = Uri.parse("$scheme:///navigation/$path")
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(context, request, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val open = action("active", 701) ?: return false
    val end = action("end?sessionId=${Uri.encode(owner)}", 702) ?: return false
    val eventAt = data.optLong("eventAtMs", 0)
    val staleAt = data.optLong("staleAtMs", now)
    val delete = Intent(context, SurfaceDismissReceiver::class.java).putExtra("owner", owner).putExtra("staleAt", staleAt).setData(Uri.parse("openmapx-surface-dismiss:${Uri.encode(owner)}"))
    val dismiss = PendingIntent.getBroadcast(context, 703, delete, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 } ?: android.R.drawable.ic_menu_directions
    val title = data.getString("title")
    val body = listOf(data.getString("instruction"), data.getString("detail")).filter { it.isNotBlank() }.joinToString(" · ")
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
    val publicCard = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)).setSmallIcon(icon).setContentTitle("OpenMapX").setContentText(if (de) "Navigation aktiv" else "Navigation active").build()
    builder.setSmallIcon(icon).setContentTitle(title).setContentText(body).setStyle(Notification.BigTextStyle().bigText(body))
      .setCategory(Notification.CATEGORY_NAVIGATION).setOngoing(data.optString("status") != "arrived").setOnlyAlertOnce(true).setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicCard)
      .setContentIntent(open).setDeleteIntent(dismiss)
      .addAction(Notification.Action.Builder(null, if (de) "Öffnen" else "Open", open).build())
      .addAction(Notification.Action.Builder(null, if (de) "Beenden" else "End", end).build())
    if (data.optString("status") == "active" && eventAt > now) builder.setWhen(eventAt).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
    if (Build.VERSION.SDK_INT >= 26) builder.setColorized(false).setTimeoutAfter((minOf(staleAt, expires) - now).coerceAtLeast(1000))
    // API24/25 have no system notification timeout. Never leave a precise turn
    // or ETA visible there after the process can no longer refresh it.
    if (Build.VERSION.SDK_INT < 26) builder.setContentTitle("OpenMapX").setContentText(if (de) "Navigation aktiv — App öffnen" else "Navigation active — open app").setStyle(null)
    // AndroidX uses this public compatibility extra; the framework setter is
    // only in SDK36.1, while this project deliberately compiles against36.
    if (Build.VERSION.SDK_INT >= 36 && data.optString("status") != "arrived") builder.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) }).setShortCriticalText(data.getString("compactText").take(7))
    manager.notify(SurfacePolicy.TAG, SurfacePolicy.ID, builder.build())
    prefs.edit().putString("owner", owner).putLong("revision", revision).apply()
    return true
  }
}
