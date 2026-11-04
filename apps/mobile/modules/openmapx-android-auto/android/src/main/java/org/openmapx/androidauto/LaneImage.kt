package org.openmapx.androidauto

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import androidx.car.app.navigation.model.LaneDirection
import org.json.JSONArray

/**
 * The lane strip of the routing card, drawn like the phone banner's lane row
 * (`LaneGuidance` "banner" variant): one cell per lane, lanes you may take on a light
 * tile, the recommended arrow fully white, other arrows of usable lanes at 60 %, arrows
 * of lanes you must not take at 35 %, stacked arrows sharing one stem. Which lanes and
 * arrows these are is decided by the shared `presentGuidanceLanes` in the projection.
 */
object LaneImage {
  private const val CELL = 76
  private const val GAP = 8
  private const val ARROW = 64

  /** Cluster/HUD lane shapes for the phone glyph names. */
  fun shape(icon: String): Int =
    when (icon) {
      "Straight" -> LaneDirection.SHAPE_STRAIGHT
      "TurnLeft" -> LaneDirection.SHAPE_NORMAL_LEFT
      "TurnRight" -> LaneDirection.SHAPE_NORMAL_RIGHT
      "TurnSlightLeft" -> LaneDirection.SHAPE_SLIGHT_LEFT
      "TurnSlightRight" -> LaneDirection.SHAPE_SLIGHT_RIGHT
      "TurnSharpLeft" -> LaneDirection.SHAPE_SHARP_LEFT
      "TurnSharpRight" -> LaneDirection.SHAPE_SHARP_RIGHT
      "UTurnLeft" -> LaneDirection.SHAPE_U_TURN_LEFT
      else -> LaneDirection.SHAPE_UNKNOWN
    }

  /** A strip says something only if some lane has an arrow. */
  fun hasArrows(lanes: JSONArray): Boolean =
    (0 until lanes.length()).any {
      (lanes.optJSONObject(it)?.optJSONArray("arrows")?.length() ?: 0) > 0
    }

  fun bitmap(context: Context, lanes: JSONArray): Bitmap {
    val count = lanes.length()
    val bitmap =
      Bitmap.createBitmap(count * CELL + (count - 1).coerceAtLeast(0) * GAP, CELL, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val tile = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(41, 255, 255, 255) }
    val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(128, 255, 255, 255) }
    for (i in 0 until count) {
      val lane = lanes.getJSONObject(i)
      val valid = lane.optBoolean("valid")
      val left = i * (CELL + GAP).toFloat()
      if (valid) canvas.drawRoundRect(RectF(left, 0f, left + CELL, CELL.toFloat()), 8f, 8f, tile)
      val arrows = lane.optJSONArray("arrows") ?: JSONArray()
      if (arrows.length() == 0) {
        // An unmarked lane: a short dash, as on the phone.
        canvas.drawRoundRect(
          RectF(left + CELL / 2f - 12f, CELL / 2f - 2f, left + CELL / 2f + 12f, CELL / 2f + 2f),
          2f,
          2f,
          dash,
        )
        continue
      }
      for (j in 0 until arrows.length()) {
        val arrow = arrows.getJSONObject(j)
        val alpha =
          when {
            !valid -> 89
            arrow.optBoolean("active") -> 255
            else -> 153
          }
        ManeuverIcons.draw(
          context,
          canvas,
          arrow.optString("icon"),
          left + (CELL - ARROW) / 2f,
          (CELL - ARROW) / 2f,
          ARROW,
          alpha,
          arrow.optDouble("stemShift", 0.0).toFloat(),
        )
      }
    }
    return bitmap
  }
}
