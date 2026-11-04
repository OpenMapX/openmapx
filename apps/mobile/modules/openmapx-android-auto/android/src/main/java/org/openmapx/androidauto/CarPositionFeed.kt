package org.openmapx.androidauto

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Positions for the car map while no trip runs, so it opens where the car is.
 *
 * A trip's committed snapshots carry their own position, so the feed only runs while the
 * car shows OpenMapX without a trip. Fixes go to the car surface only; nothing is stored.
 */
class CarPositionFeed(private val context: Context, private val emit: (JSONObject) -> Unit) {
  private val manager = context.getSystemService(LocationManager::class.java)
  private var running = false
  private val listener = LocationListener { emit(message(it)) }

  fun update(wanted: Boolean) {
    if (wanted == running) return
    if (!wanted) {
      manager.removeUpdates(listener)
      running = false
      return
    }
    if (
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) !=
        PackageManager.PERMISSION_GRANTED
    )
      return
    val provider =
      if (Build.VERSION.SDK_INT >= 31 && manager.hasProvider(LocationManager.FUSED_PROVIDER))
        LocationManager.FUSED_PROVIDER
      else LocationManager.GPS_PROVIDER
    try {
      manager.getLastKnownLocation(provider)?.let { emit(message(it)) }
      manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper())
      running = true
    } catch (_: SecurityException) {
      running = false
    } catch (_: IllegalArgumentException) {
      running = false
    }
  }

  companion object {
    fun message(location: Location): JSONObject =
      JSONObject()
        .put("v", 1)
        .put("type", "car-position")
        .put("lng", location.longitude)
        .put("lat", location.latitude)
        .put("accuracy", location.accuracy.toDouble().coerceIn(0.0, 10000.0))
        .apply {
          if (location.hasBearing()) put("bearing", location.bearing.toDouble().mod(360.0))
          if (location.hasSpeed()) put("speedMps", location.speed.toDouble().coerceIn(0.0, 200.0))
        }
  }
}
