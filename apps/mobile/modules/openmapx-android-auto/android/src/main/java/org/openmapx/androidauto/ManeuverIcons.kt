package org.openmapx.androidauto

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import androidx.core.content.ContextCompat
import androidx.core.graphics.PathParser
import org.json.JSONObject

/**
 * The phone's guidance glyphs (Material icons, named as in `@openmapx/core`
 * `GuidanceIconName`), drawn for the routing card, lane strip, cluster and
 * notification. The projection names the glyph; this only draws it.
 */
object ManeuverIcons {
  private const val SIZE = 128

  private val drawables =
    mapOf(
      "Straight" to R.drawable.guidance_straight,
      "TurnLeft" to R.drawable.guidance_turn_left,
      "TurnRight" to R.drawable.guidance_turn_right,
      "TurnSlightLeft" to R.drawable.guidance_turn_slight_left,
      "TurnSlightRight" to R.drawable.guidance_turn_slight_right,
      "TurnSharpLeft" to R.drawable.guidance_turn_sharp_left,
      "TurnSharpRight" to R.drawable.guidance_turn_sharp_right,
      "UTurnLeft" to R.drawable.guidance_uturn_left,
      "MergeType" to R.drawable.guidance_merge_type,
      "RoundaboutLeft" to R.drawable.guidance_roundabout_left,
      "RoundaboutRight" to R.drawable.guidance_roundabout_right,
      "Flag" to R.drawable.guidance_flag,
    )

  /** Glyphs a car projection may name; anything else falls back to Straight. */
  val names: Set<String> = drawables.keys

  /**
   * Draws [icon] white into a square of [size] px whose left edge is at [x], shifted by
   * [shift] icon widths, at [alpha] (0–255).
   */
  fun draw(
    context: Context,
    canvas: Canvas,
    icon: String,
    x: Float,
    y: Float,
    size: Int,
    alpha: Int = 255,
    shift: Float = 0f,
  ) {
    val drawable =
      ContextCompat.getDrawable(context, drawables[icon] ?: R.drawable.guidance_straight)?.mutate()
        ?: return
    val left = (x + shift * size).toInt()
    drawable.setBounds(left, y.toInt(), left + size, y.toInt() + size)
    drawable.alpha = alpha
    drawable.draw(canvas)
  }

  /**
   * The maneuver's glyph: [glyph], the path data the phone drew (a roundabout's way
   * round, validated by `CarProjection`), when given; otherwise the named [icon].
   */
  fun bitmap(context: Context, icon: String, glyph: JSONObject? = null): Bitmap {
    val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    if (glyph == null || !drawGlyph(canvas, glyph, SIZE)) draw(context, canvas, icon, 0f, 0f, SIZE)
    return bitmap
  }

  /** Path data on the phone's 24 × 24 grid, or null when it does not parse. */
  private fun path(data: String): Path? =
    try {
      PathParser.createPathFromPathData(data)
    } catch (_: RuntimeException) {
      null
    }

  /** Strokes then fills, white, scaled to [size]; false when any path fails to parse. */
  private fun drawGlyph(canvas: Canvas, glyph: JSONObject, size: Int): Boolean {
    val strokes = glyph.optJSONArray("strokes") ?: return false
    val fills = glyph.optJSONArray("fills") ?: return false
    val stroked =
      (0 until strokes.length()).map { i ->
        val stroke = strokes.getJSONObject(i)
        Triple(path(stroke.optString("d")) ?: return false, stroke.optDouble("width"), stroke.optDouble("opacity", 1.0))
      }
    val filled = (0 until fills.length()).map { i -> path(fills.optString(i)) ?: return false }
    canvas.save()
    canvas.scale(size / 24f, size / 24f)
    for ((p, width, opacity) in stroked) {
      canvas.drawPath(
        p,
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
          style = Paint.Style.STROKE
          color = android.graphics.Color.WHITE
          alpha = (opacity.coerceIn(0.0, 1.0) * 255).toInt()
          strokeWidth = width.toFloat()
          strokeCap = Paint.Cap.ROUND
          strokeJoin = Paint.Join.ROUND
        },
      )
    }
    val fill =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = android.graphics.Color.WHITE
      }
    for (p in filled) canvas.drawPath(p, fill)
    canvas.restore()
    return true
  }
}
