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

  fun maneuverIcon(maneuver: String): android.graphics.Bitmap {
    val bitmap =
      android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888)
    val arrow =
      when {
        maneuver.contains("roundabout") -> "↻"
        maneuver.contains("uturn") -> "↶"
        maneuver.contains("left") -> "↰"
        maneuver.contains("right") -> "↱"
        maneuver == "arrive" -> "⚑"
        else -> "↑"
      }
    val paint =
      android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = 56f
        textAlign = android.graphics.Paint.Align.CENTER
      }
    android.graphics.Canvas(bitmap).drawText(arrow, 32f, 54f, paint)
    return bitmap
  }

  fun distanceText(p: JSONObject): String {
    val distance =
      CarTripMapper.distance(
        p.optDouble("distanceToManeuver"),
        p.optString("units", CarState.units),
      )
    val locale = Locale.forLanguageTag(p.optString("locale", CarState.locale))
    val number = NumberFormat.getNumberInstance(locale).apply { maximumFractionDigits = 1 }
    val unit =
      when (distance.displayUnit) {
        androidx.car.app.model.Distance.UNIT_KILOMETERS -> "km"
        androidx.car.app.model.Distance.UNIT_MILES -> "mi"
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
        .setLargeIcon(maneuverIcon(p.optString("maneuver")))
        .setContentTitle(p.optString("instruction"))
        .setContentText(distanceText(p))
        .setImportance(
          if (changed) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_LOW
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
