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

  fun distanceText(p: JSONObject): String {
    val distance =
      CarTripMapper.distance(p.optDouble("distanceToManeuver"), p.optString("units", CarState.units))
    // The host formats the routing card with the system locale; the rail matches it.
    val number =
      NumberFormat.getNumberInstance(Locale.getDefault()).apply {
        val decimal =
          distance.displayUnit == androidx.car.app.model.Distance.UNIT_KILOMETERS_P1 ||
            distance.displayUnit == androidx.car.app.model.Distance.UNIT_MILES_P1
        minimumFractionDigits = if (decimal) 1 else 0
        maximumFractionDigits = if (decimal) 1 else 0
      }
    val unit =
      when (distance.displayUnit) {
        androidx.car.app.model.Distance.UNIT_KILOMETERS,
        androidx.car.app.model.Distance.UNIT_KILOMETERS_P1 -> "km"
        androidx.car.app.model.Distance.UNIT_MILES,
        androidx.car.app.model.Distance.UNIT_MILES_P1 -> "mi"
        androidx.car.app.model.Distance.UNIT_FEET -> "ft"
        else -> "m"
      }
    return "${number.format(distance.displayDistance)} $unit"
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
