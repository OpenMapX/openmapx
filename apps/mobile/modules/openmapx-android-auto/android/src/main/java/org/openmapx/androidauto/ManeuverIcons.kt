package org.openmapx.androidauto

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** Turn arrows for the routing card, cluster and notification; the host draws no icon of its own. */
object ManeuverIcons {
  private const val SIZE = 128
  private const val STROKE = 15f
  private const val HEAD_LENGTH = 30f
  private const val HEAD_HALF = 24f
  private val DIM = Color.argb(90, 255, 255, 255)

  fun bitmap(maneuver: String): Bitmap {
    val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    when {
      maneuver == "arrive" -> destination(canvas)
      maneuver.startsWith("roundabout") -> roundabout(canvas, maneuver.endsWith("cw"))
      maneuver.startsWith("uturn") -> uTurn(canvas, maneuver.endsWith("left"))
      maneuver.startsWith("keep") -> {
        // A fork: the branch to skip dimmed, the one to take bright.
        val side = if (maneuver.endsWith("left")) -1f else 1f
        arrow(canvas, -side * 36f, DIM, junctionY = 66f, centred = true)
        arrow(canvas, side * 36f, Color.WHITE, junctionY = 66f, centred = true)
      }
      else -> arrow(canvas, angle(maneuver), Color.WHITE)
    }
    return bitmap
  }

  /** Degrees from straight ahead; negative turns left. */
  fun angle(maneuver: String): Float =
    when (maneuver) {
      "keep-left" -> -28f
      "slight-left" -> -45f
      "left" -> -90f
      "sharp-left" -> -135f
      "keep-right" -> 28f
      "slight-right" -> 45f
      "right" -> 90f
      "sharp-right" -> 135f
      else -> 0f
    }

  private fun stroke(colour: Int) =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = colour
      style = Paint.Style.STROKE
      strokeWidth = STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }

  private fun fill(colour: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colour }

  /**
   * A stem from the bottom that bends smoothly at the junction into the exit direction,
   * ending in an arrowhead whose base meets the line.
   */
  private fun arrow(
    canvas: Canvas,
    degrees: Float,
    colour: Int,
    junctionY: Float = 62f,
    centred: Boolean = false,
  ) {
    val radians = Math.toRadians(degrees.toDouble())
    val dx = sin(radians).toFloat()
    val dy = -cos(radians).toFloat()
    // The stem sits away from the turn so the exit leg and head fit in the icon.
    val stem = if (centred) 64f else 64f - dx * 20f
    val path = Path().apply { moveTo(stem, 120f) }
    val tipX: Float
    val tipY: Float
    if (degrees == 0f) {
      tipX = 64f
      tipY = 10f
      path.lineTo(64f, tipY + HEAD_LENGTH)
    } else {
      // Leg lengths keep every tip inside the 128 px canvas (checked in CarMappingTest).
      val leg =
        when {
          abs(degrees) < 40f -> 12f
          abs(degrees) < 60f -> 26f
          abs(degrees) < 100f -> 24f
          else -> 20f
        }
      val bend = 16f
      tipX = stem + dx * (bend + leg + HEAD_LENGTH)
      tipY = junctionY + dy * (bend + leg + HEAD_LENGTH)
      val baseX = tipX - dx * HEAD_LENGTH
      val baseY = tipY - dy * HEAD_LENGTH
      path.lineTo(stem, junctionY + bend)
      path.quadTo(stem, junctionY, stem + dx * bend, junctionY + dy * bend)
      path.lineTo(baseX, baseY)
    }
    canvas.drawPath(path, stroke(colour))
    head(canvas, fill(colour), tipX, tipY, dx, dy)
  }

  private fun uTurn(canvas: Canvas, left: Boolean) {
    val (from, to) = if (left) 88f to 40f else 40f to 88f
    val path =
      Path().apply {
        moveTo(from, 120f)
        lineTo(from, 52f)
        arcTo(RectF(40f, 28f, 88f, 76f), if (left) 0f else 180f, if (left) -180f else 180f)
        lineTo(to, 70f)
      }
    canvas.drawPath(path, stroke(Color.WHITE))
    head(canvas, fill(Color.WHITE), to, 100f, 0f, 1f)
  }

  private fun roundabout(canvas: Canvas, clockwise: Boolean) {
    val ring = stroke(Color.WHITE)
    canvas.drawCircle(64f, 60f, 24f, ring)
    canvas.drawLine(64f, 120f, 64f, 84f, ring)
    val side = if (clockwise) -1f else 1f
    val d = 0.7071f
    canvas.drawLine(64f + side * 17f, 43f, 64f + side * 28f, 32f, ring)
    head(
      canvas,
      fill(Color.WHITE),
      64f + side * (28f + d * HEAD_LENGTH),
      32f - d * HEAD_LENGTH,
      side * d,
      -d,
    )
  }

  private fun destination(canvas: Canvas) {
    val pin =
      Path().apply {
        addCircle(64f, 48f, 32f, Path.Direction.CW)
        moveTo(36f, 64f)
        lineTo(64f, 120f)
        lineTo(92f, 64f)
        close()
      }
    canvas.drawPath(pin, fill(Color.WHITE))
    canvas.drawCircle(64f, 48f, 12f, fill(Color.BLACK))
  }

  /** A filled arrowhead with its tip at (x, y), pointing along the unit vector (dx, dy). */
  private fun head(canvas: Canvas, paint: Paint, x: Float, y: Float, dx: Float, dy: Float) {
    val baseX = x - dx * HEAD_LENGTH
    val baseY = y - dy * HEAD_LENGTH
    val path =
      Path().apply {
        moveTo(x, y)
        lineTo(baseX - dy * HEAD_HALF, baseY + dx * HEAD_HALF)
        lineTo(baseX + dy * HEAD_HALF, baseY - dx * HEAD_HALF)
        close()
      }
    canvas.drawPath(path, paint)
  }
}
