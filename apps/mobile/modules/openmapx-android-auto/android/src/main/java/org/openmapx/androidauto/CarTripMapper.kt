package org.openmapx.androidauto

import android.content.Context
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
  /** Rounded like spoken guidance: no "614.8 m", whole tens and fifties, one km decimal below 10. */
  fun distance(meters: Double, units: String = CarState.units): Distance {
    val safe = if (meters.isFinite()) meters.coerceAtLeast(0.0) else 0.0
    return if (units == "imperial") {
      val feet = safe / 0.3048
      val miles = safe / 1609.344
      when {
        feet < 528 -> Distance.create(roundTo(feet, if (feet < 100) 10.0 else 50.0), Distance.UNIT_FEET)
        miles < 10 -> Distance.create(Math.round(miles * 10) / 10.0, Distance.UNIT_MILES_P1)
        else -> Distance.create(Math.round(miles).toDouble(), Distance.UNIT_MILES)
      }
    } else {
      when {
        safe < 950 -> Distance.create(roundTo(safe, if (safe < 100) 10.0 else 50.0), Distance.UNIT_METERS)
        safe < 9950 ->
          Distance.create(Math.round(safe / 100) / 10.0, Distance.UNIT_KILOMETERS_P1)
        else -> Distance.create(Math.round(safe / 1000).toDouble(), Distance.UNIT_KILOMETERS)
      }
    }
  }

  private fun roundTo(value: Double, step: Double) = Math.round(value / step) * step

  fun step(context: Context, p: JSONObject): Step =
    Step.Builder(p.getString("instruction"))
      .setManeuver(
        Maneuver.Builder(
            when (p.optString("maneuver")) {
              "left" -> Maneuver.TYPE_TURN_NORMAL_LEFT
              "right" -> Maneuver.TYPE_TURN_NORMAL_RIGHT
              "slight-left" -> Maneuver.TYPE_TURN_SLIGHT_LEFT
              "slight-right" -> Maneuver.TYPE_TURN_SLIGHT_RIGHT
              "keep-left" -> Maneuver.TYPE_KEEP_LEFT
              "keep-right" -> Maneuver.TYPE_KEEP_RIGHT
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
            setIcon(
              CarIcon.Builder(
                  IconCompat.createWithBitmap(ManeuverIcons.bitmap(context, p.optString("maneuverIcon")))
                )
                .build()
            )
          }
          .build()
      )
      .apply {
        val lanes = p.optJSONArray("lanes")
        // Present only once the maneuver is near, exactly as the phone shows them.
        if (lanes != null && lanes.length() > 0 && LaneImage.hasArrows(lanes)) {
          for (i in 0 until lanes.length()) {
            val lane = lanes.getJSONObject(i)
            val arrows = lane.optJSONArray("arrows") ?: continue
            val builder = Lane.Builder()
            for (j in 0 until arrows.length()) {
              val arrow = arrows.getJSONObject(j)
              builder.addDirection(
                LaneDirection.create(
                  LaneImage.shape(arrow.optString("icon")),
                  lane.optBoolean("valid") && arrow.optBoolean("active"),
                )
              )
            }
            if (arrows.length() > 0) addLane(builder.build())
          }
          setLanesImage(
            CarIcon.Builder(IconCompat.createWithBitmap(LaneImage.bitmap(context, lanes))).build()
          )
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

  fun trip(context: Context, p: JSONObject, destinationName: String): Trip {
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
      .addStep(step(context, p), stepEstimate)
      .addDestination(Destination.Builder().setName(destinationName).build(), estimate(p))
      .build()
  }
}
