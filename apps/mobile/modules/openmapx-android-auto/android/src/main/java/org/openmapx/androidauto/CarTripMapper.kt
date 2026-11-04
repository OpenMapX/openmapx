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
  /**
   * A distance already rounded by the shared `measurementDistanceParts` (the phone
   * banner's rule), as the host's Distance. The host shows at most one decimal for
   * miles, so the phone's two-decimal miles are shown with one.
   */
  fun distance(parts: JSONObject?): Distance {
    val value = parts?.optDouble("value", 0.0)?.takeIf { it.isFinite() && it >= 0 } ?: 0.0
    val decimals = parts?.optInt("decimals", 0) ?: 0
    return when (parts?.optString("unit")) {
      "km" ->
        Distance.create(value, if (decimals > 0) Distance.UNIT_KILOMETERS_P1 else Distance.UNIT_KILOMETERS)
      "ft" -> Distance.create(value, Distance.UNIT_FEET)
      "mi" -> Distance.create(value, Distance.UNIT_MILES_P1)
      else -> Distance.create(value, Distance.UNIT_METERS)
    }
  }

  /**
   * The host's turn type, for the cluster and HUD, from the shared glyph the phone draws
   * (`maneuverIconName`); only a roundabout's circling direction comes separately.
   */
  fun maneuverType(p: JSONObject): Int {
    p.optJSONObject("roundabout")?.let {
      return if (it.optBoolean("clockwise")) Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW
      else Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW
    }
    return when (p.optString("maneuverIcon")) {
      "TurnLeft" -> Maneuver.TYPE_TURN_NORMAL_LEFT
      "TurnRight" -> Maneuver.TYPE_TURN_NORMAL_RIGHT
      "TurnSlightLeft" -> Maneuver.TYPE_TURN_SLIGHT_LEFT
      "TurnSlightRight" -> Maneuver.TYPE_TURN_SLIGHT_RIGHT
      "TurnSharpLeft" -> Maneuver.TYPE_TURN_SHARP_LEFT
      "TurnSharpRight" -> Maneuver.TYPE_TURN_SHARP_RIGHT
      "UTurnLeft" -> Maneuver.TYPE_U_TURN_LEFT
      "MergeType" -> Maneuver.TYPE_MERGE_SIDE_UNSPECIFIED
      "Flag" -> Maneuver.TYPE_DESTINATION
      else -> Maneuver.TYPE_STRAIGHT
    }
  }

  fun step(context: Context, p: JSONObject): Step =
    Step.Builder(p.getString("instruction"))
      .setManeuver(
        Maneuver.Builder(maneuverType(p))
          .apply {
            p.optJSONObject("roundabout")?.let {
              setRoundaboutExitNumber(it.optInt("exit", 1).coerceIn(1, 99))
            }
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
        distance(p.optJSONObject("remainingDistanceDisplay")),
        DateTimeWithZone.create(p.optLong("etaMs"), TimeZone.getDefault()),
      )
      .setRemainingTimeSeconds(p.optLong("remainingSeconds").coerceAtLeast(0))
      .build()

  fun trip(context: Context, p: JSONObject, destinationName: String): Trip {
    if (p.optBoolean("rerouting")) return Trip.Builder().setLoading(true).build()
    val stepEstimate =
      TravelEstimate.Builder(
          distance(p.optJSONObject("maneuverDistance")),
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
