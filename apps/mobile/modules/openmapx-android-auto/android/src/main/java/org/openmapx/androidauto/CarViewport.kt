package org.openmapx.androidauto

import android.graphics.Rect
import org.json.JSONObject

/** Converts host safe rectangles to bounded CSS edge insets. */
object CarViewport {
  fun insets(rect: Rect, width: Int, height: Int, density: Float): JSONObject {
    val d = density.coerceAtLeast(0.1f)
    return JSONObject()
      .put("top", rect.top.coerceIn(0, height) / d)
      .put("left", rect.left.coerceIn(0, width) / d)
      .put("right", (width - rect.right).coerceIn(0, width) / d)
      .put("bottom", (height - rect.bottom).coerceIn(0, height) / d)
  }
}
