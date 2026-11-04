package org.openmapx.androidauto

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import androidx.car.app.notification.CarAppExtender
import androidx.core.app.NotificationCompat
import expo.modules.openmapxnavigationsurfaces.NavigationSurfaceHooks
import java.text.NumberFormat
import java.util.Locale
import org.json.JSONObject

/**
 * Android Auto's turn-by-turn notification (NF-3) is the trip's existing phone navigation
 * card, extended for the car: the car rail shows the turn, its distance and arrow, and a
 * new turn pops up only while another app is on the car screen. No second notification.
 */
object GuidanceNotification {
  private var lastManeuver: String? = null

  fun install() {
    NavigationSurfaceHooks.decorate = ::decorate
  }

  /** Re-posts the card when the car's turn, connection or visibility changes. */
  fun refresh(context: Context) {
    NavigationSurfaceHooks.refresh(context)
  }

  /** The rail's distance text, from the shared rounding, in the phone's number format. */
  fun distanceText(p: JSONObject): String {
    val parts = p.optJSONObject("maneuverDistance") ?: return ""
    val decimals = parts.optInt("decimals", 0)
    // The host formats its routing card with the system locale; the rail matches it.
    val number =
      NumberFormat.getNumberInstance(Locale.getDefault()).apply {
        minimumFractionDigits = decimals
        maximumFractionDigits = decimals
        isGroupingUsed = false
      }
    return "${number.format(parts.optDouble("value", 0.0))} ${parts.optString("unit", "m")}"
  }

  internal fun decorate(context: Context, card: JSONObject, builder: Notification.Builder) {
    val p = CarState.projection
    if (!CarState.connected || p == null || p.optString("sessionId") != card.optString("sessionId")) {
      lastManeuver = null
      return
    }
    val key = "${p.optString("sessionId")}:${p.optString("maneuverId")}:${p.optString("instruction")}"
    val changed = key != lastManeuver
    lastManeuver = key
    val extender =
      CarAppExtender.Builder()
        .setLargeIcon(ManeuverIcons.bitmap(context, p.optString("maneuverIcon")))
        .setContentTitle(p.optString("instruction"))
        .setContentText(distanceText(p))
        // The routing card already shows a new turn while OpenMapX is on the car screen;
        // the heads-up alert is for when another app is in front.
        .setImportance(
          if (changed && !CarState.visible) NotificationManager.IMPORTANCE_HIGH
          else NotificationManager.IMPORTANCE_LOW
        )
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      extender.setContentIntent(
        PendingIntent.getActivity(
          context,
          406,
          it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      )
    }
    // CarAppExtender writes its data into the notification extras; the card itself is a
    // framework Notification.Builder, so the extras are carried over.
    builder.addExtras(NotificationCompat.Builder(context, "car").extend(extender.build()).extras)
    if (changed) builder.setOnlyAlertOnce(false)
  }
}
