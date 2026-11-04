package org.openmapx.androidauto

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.car.app.notification.CarAppExtender
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.text.NumberFormat
import java.util.Locale
import org.json.JSONObject

/** Connected-car guidance; progress updates never repeat the maneuver heads-up alert. */
object GuidanceNotification {
  private const val ID = 406
  private const val CHANNEL = "openmapx-turns"
  private var foregroundNotification: android.service.notification.StatusBarNotification? = null
  private var lastId = ID
  private var lastManeuver: String? = null

  fun maneuverIcon(context: Context, icon: String): android.graphics.Bitmap =
    ManeuverIcons.bitmap(context, icon)

  fun distanceText(p: JSONObject): String {
    val distance =
      CarTripMapper.distance(
        p.optDouble("distanceToManeuver"),
        p.optString("units", CarState.units),
      )
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

  fun update(context: Context, p: JSONObject?) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (!CarState.connected || p == null) {
      if (lastId == ID) manager.cancel(ID)
      foregroundNotification?.let { original ->
        if (manager.activeNotifications.any { it.id == original.id })
          manager.notify(original.id, original.notification)
      }
      foregroundNotification = null
      lastManeuver = null
      return
    }
    if (
      Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
    ) {
      manager.cancel(ID)
      return
    }
    val localized =
      context.createConfigurationContext(
        android.content.res.Configuration(context.resources.configuration).apply {
          setLocale(Locale.forLanguageTag(p.optString("locale", CarState.locale)))
        }
      )
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL,
        localized.getString(R.string.car_channel),
        NotificationManager.IMPORTANCE_LOW,
      )
    )
    val location =
      manager.activeNotifications.firstOrNull {
        it.notification.channelId == "${context.packageName}:openmapx-navigation-location" ||
          it.id == foregroundNotification?.id
      }
    if (location != null && foregroundNotification?.id != location.id)
      foregroundNotification = location
    val notificationId = location?.id ?: ID
    if (lastId == ID && notificationId != ID) manager.cancel(ID)
    lastId = notificationId
    val key =
      "${p.optString("sessionId")}:${p.optString("maneuverId")}:${p.optString("instruction")}:${p.optString("maneuver")}"
    val changed = key != lastManeuver
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val intent =
      launch?.let {
        PendingIntent.getActivity(
          context,
          ID,
          it,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }
    val extender =
      CarAppExtender.Builder()
        .setLargeIcon(maneuverIcon(context, p.optString("maneuverIcon")))
        .setContentTitle(p.optString("instruction"))
        .setContentText(distanceText(p))
        // The routing card already shows a new maneuver while OpenMapX is on the car screen;
        // the heads-up alert is for when another app is in front.
        .setImportance(
          if (changed && !CarState.visible) NotificationManager.IMPORTANCE_HIGH
          else NotificationManager.IMPORTANCE_LOW
        )
    if (intent != null) extender.setContentIntent(intent)
    val builder =
      NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.ic_dialog_map)
        .setContentTitle(p.optString("instruction"))
        .setContentText(distanceText(p))
        .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
        .setOngoing(true)
        .setOnlyAlertOnce(!changed)
        .extend(extender.build())
    if (intent != null) builder.setContentIntent(intent)
    try {
      manager.notify(notificationId, builder.build())
      lastManeuver = key
    } catch (_: SecurityException) {
      manager.cancel(ID)
    }
  }
}
