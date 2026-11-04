package org.openmapx.androidauto

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import androidx.car.app.navigation.model.LaneDirection
import org.json.JSONArray
import org.json.JSONObject

/** The lane-guidance strip of the routing card: one arrow per lane, recommended lanes bright. */
object LaneImage {
  private const val LANE = 72
  private const val HEIGHT = 96

  fun shape(indication: String): Int =
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

  fun recommended(lane: JSONObject, indication: String): Boolean =
    lane.optBoolean("valid") &&
      (lane.optString("active").isEmpty() || lane.optString("active") == indication)

  fun hasMarkings(lanes: JSONArray): Boolean =
    (0 until lanes.length()).any { i ->
      val indications = lanes.optJSONObject(i)?.optJSONArray("indications") ?: return@any false
      (0 until indications.length()).any {
        shape(indications.optString(it)) != LaneDirection.SHAPE_UNKNOWN
      }
    }

  fun bitmap(lanes: JSONArray): Bitmap {
    val bitmap = Bitmap.createBitmap(lanes.length() * LANE, HEIGHT, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 9f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
      }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    for (i in 0 until lanes.length()) {
      val lane = lanes.getJSONObject(i)
      val indications = lane.getJSONArray("indications")
      val centre = i * LANE + LANE / 2f
      // Unmarked lanes still read as a lane: a dim straight arrow.
      val marks =
        (0 until indications.length()).map { indications.getString(it) }.ifEmpty { listOf("none") }
      for (indication in marks) {
        val bright = recommended(lane, indication) && shape(indication) != LaneDirection.SHAPE_UNKNOWN
        val colour = if (bright) Color.WHITE else Color.argb(110, 255, 255, 255)
        stroke.color = colour
        fill.color = colour
        val side =
          when {
            indication.contains("left") -> -1f
            indication.contains("right") -> 1f
            else -> 0f
          }
        val bend = if (indication.startsWith("slight")) 14f else 24f
        val tipX = centre + side * bend
        val path =
          Path().apply {
            moveTo(centre, 88f)
            lineTo(centre, 48f)
            if (side != 0f) lineTo(tipX, 30f) else lineTo(centre, 30f)
          }
        canvas.drawPath(path, stroke)
        val dx = if (side == 0f) 0f else side * 0.6f
        val dy = if (side == 0f) -1f else -0.8f
        val head =
          Path().apply {
            moveTo(tipX + dx * 14f, 30f + dy * 14f)
            lineTo(tipX - dx * 6f - dy * 14f, 30f - dy * 6f + dx * 14f)
            lineTo(tipX - dx * 6f + dy * 14f, 30f - dy * 6f - dx * 14f)
            close()
          }
        canvas.drawPath(head, fill)
      }
    }
    return bitmap
  }
}
