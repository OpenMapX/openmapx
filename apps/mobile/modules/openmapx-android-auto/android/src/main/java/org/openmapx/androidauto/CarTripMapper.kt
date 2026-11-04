package org.openmapx.androidauto

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.model.Distance
import androidx.car.app.navigation.model.Destination
import androidx.car.app.navigation.model.Lane
import androidx.car.app.navigation.model.LaneDirection
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.Step
import androidx.car.app.navigation.model.TravelEstimate
import androidx.car.app.navigation.model.Trip
import androidx.core.graphics.drawable.IconCompat
import java.util.TimeZone
import org.json.JSONObject

/** Pure mapping from committed trip projections to Android for Cars metadata. */
object CarTripMapper {
  fun distance(meters: Double, units: String = CarState.units): Distance {
    val safe = if (meters.isFinite()) meters.coerceAtLeast(0.0) else 0.0
    return if (units == "imperial") {
      if (safe < 160.9344) Distance.create(safe / 0.3048, Distance.UNIT_FEET)
      else Distance.create(safe / 1609.344, Distance.UNIT_MILES)
    } else {
      if (safe < 1000) Distance.create(safe, Distance.UNIT_METERS)
      else Distance.create(safe / 1000, Distance.UNIT_KILOMETERS)
    }
  }

  fun step(p: JSONObject): Step =
    Step.Builder(p.getString("instruction"))
      .setManeuver(
        Maneuver.Builder(
            when (p.optString("maneuver")) {
              "left" -> Maneuver.TYPE_TURN_NORMAL_LEFT
              "right" -> Maneuver.TYPE_TURN_NORMAL_RIGHT
              "slight-left" -> Maneuver.TYPE_TURN_SLIGHT_LEFT
              "slight-right" -> Maneuver.TYPE_TURN_SLIGHT_RIGHT
              "sharp-left" -> Maneuver.TYPE_TURN_SHARP_LEFT
              "sharp-right" -> Maneuver.TYPE_TURN_SHARP_RIGHT
              "uturn-left" -> Maneuver.TYPE_U_TURN_LEFT
              "uturn-right" -> Maneuver.TYPE_U_TURN_RIGHT
              "arrive" -> Maneuver.TYPE_DESTINATION
              "roundabout-cw" -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW
              "roundabout" -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW
              else -> Maneuver.TYPE_STRAIGHT
            }
          )
          .apply {
            if (p.optString("maneuver").startsWith("roundabout"))
              setRoundaboutExitNumber(p.optInt("exit", 1).coerceIn(1, 99))
          }
          .build()
      )
      .apply {
        val lanes = p.optJSONArray("lanes")
        if (lanes != null && lanes.length() > 0) {
          val bitmap = Bitmap.createBitmap(lanes.length() * 48, 64, Bitmap.Config.ARGB_8888)
          val canvas = Canvas(bitmap)
          val paint =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
              strokeWidth = 4f
              style = Paint.Style.STROKE
            }
          for (i in 0 until lanes.length()) {
            val lane = lanes.getJSONObject(i)
            val indications = lane.getJSONArray("indications")
            val builder = Lane.Builder()
            for (j in 0 until indications.length()) {
              val indication = indications.getString(j)
              val recommended =
                lane.optBoolean("valid") &&
                  (lane.optString("active").isEmpty() || lane.optString("active") == indication)
              val shape =
                when (indication) {
                  "straight" -> LaneDirection.SHAPE_STRAIGHT
                  "left" -> LaneDirection.SHAPE_NORMAL_LEFT
                  "right" -> LaneDirection.SHAPE_NORMAL_RIGHT
                  "slight left" -> LaneDirection.SHAPE_SLIGHT_LEFT
                  "slight right" -> LaneDirection.SHAPE_SLIGHT_RIGHT
                  "sharp left" -> LaneDirection.SHAPE_SHARP_LEFT
                  "sharp right" -> LaneDirection.SHAPE_SHARP_RIGHT
                  "uturn" -> LaneDirection.SHAPE_U_TURN_LEFT
                  else -> LaneDirection.SHAPE_UNKNOWN
                }
              builder.addDirection(LaneDirection.create(shape, recommended))
              if (shape == LaneDirection.SHAPE_UNKNOWN) continue
              paint.color = if (recommended) Color.WHITE else Color.GRAY
              val x = i * 48f + 24f
              val dx =
                if (indication.contains("left")) -14f
                else if (indication.contains("right")) 14f else 0f
              canvas.drawLine(x, 56f, x, 32f, paint)
              canvas.drawLine(x, 32f, x + dx, 12f, paint)
              canvas.drawLine(x + dx, 12f, x + dx - 7f, 22f, paint)
              canvas.drawLine(x + dx, 12f, x + dx + 7f, 22f, paint)
            }
            if (indications.length() > 0) addLane(builder.build())
          }
          setLanesImage(CarIcon.Builder(IconCompat.createWithBitmap(bitmap)).build())
        }
      }
      .build()

  fun estimate(p: JSONObject): TravelEstimate =
    TravelEstimate.Builder(
        distance(p.optDouble("remainingDistance")),
        DateTimeWithZone.create(p.optLong("etaMs"), TimeZone.getDefault()),
      )
      .setRemainingTimeSeconds(p.optLong("remainingSeconds").coerceAtLeast(0))
      .build()

  fun trip(p: JSONObject, destinationName: String): Trip {
    if (p.optBoolean("rerouting")) return Trip.Builder().setLoading(true).build()
    val stepEstimate =
      TravelEstimate.Builder(
          distance(p.optDouble("distanceToManeuver")),
          DateTimeWithZone.create(
            p.optLong("maneuverEtaMs", p.optLong("etaMs")),
            TimeZone.getDefault(),
          ),
        )
        .setRemainingTimeSeconds(p.optLong("secondsToManeuver").coerceAtLeast(0))
        .build()
    return Trip.Builder()
      .addStep(step(p), stepEstimate)
      .addDestination(Destination.Builder().setName(destinationName).build(), estimate(p))
      .build()
  }
}
