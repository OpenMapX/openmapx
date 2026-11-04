package org.openmapx.androidauto

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.core.content.ContextCompat

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

  fun bitmap(context: Context, icon: String): Bitmap {
    val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    draw(context, Canvas(bitmap), icon, 0f, 0f, SIZE)
    return bitmap
  }
}
