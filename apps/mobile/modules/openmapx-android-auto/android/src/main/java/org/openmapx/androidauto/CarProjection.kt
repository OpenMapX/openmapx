package org.openmapx.androidauto

import org.json.JSONObject

/** Rejects malformed native projections before host builders or notification APIs consume them. */
object CarProjection {
  fun parse(value: JSONObject?): JSONObject? {
    if (value == null) return null
    if (value.optString("sessionId").length !in 1..128) return null
    if (value.optString("instruction").length !in 1..1024) return null
    if (value.optString("locale") !in listOf("en", "de")) return null
    if (value.optString("units") !in listOf("metric", "imperial")) return null
    for (key in
      listOf(
        "revision",
        "distanceToManeuver",
        "secondsToManeuver",
        "maneuverEtaMs",
        "remainingDistance",
        "remainingSeconds",
        "etaMs",
      )) {
      val number = value.opt(key) as? Number ?: return null
      if (!number.toDouble().isFinite() || number.toDouble() < 0) return null
    }
    if (value.optString("maneuverIcon") !in ManeuverIcons.names) return null
    if (value.has("roundabout")) {
      val roundabout = value.optJSONObject("roundabout") ?: return null
      if (roundabout.opt("exit") !is Int || roundabout.optInt("exit") !in 1..99) return null
      if (roundabout.opt("clockwise") !is Boolean) return null
      if (roundabout.has("angle") && (roundabout.opt("angle") !is Int || roundabout.optInt("angle") !in 1..360))
        return null
      if (roundabout.has("leaving") && roundabout.opt("leaving") != true) return null
    }
    if (value.has("maneuverGlyph") && !validGlyph(value.optJSONObject("maneuverGlyph"))) return null
    for (key in listOf("maneuverDistance", "remainingDistanceDisplay")) {
      val parts = value.optJSONObject(key) ?: return null
      if (parts.optString("unit") !in setOf("m", "km", "ft", "mi")) return null
      val shown = parts.opt("value") as? Number ?: return null
      if (!shown.toDouble().isFinite() || shown.toDouble() < 0) return null
      if (parts.optInt("decimals", -1) !in 0..2) return null
    }
    val lanes = value.optJSONArray("lanes")
    if (lanes != null) {
      if (lanes.length() > 12) return null
      for (i in 0 until lanes.length()) {
        val lane = lanes.optJSONObject(i) ?: return null
        val arrows = lane.optJSONArray("arrows") ?: return null
        if (arrows.length() > 8 || lane.opt("valid") !is Boolean) return null
        for (j in 0 until arrows.length()) {
          val arrow = arrows.optJSONObject(j) ?: return null
          if (arrow.optString("icon") !in ManeuverIcons.names) return null
          if (arrow.opt("active") !is Boolean) return null
          val shift = arrow.opt("stemShift") as? Number ?: return null
          if (!shift.toDouble().isFinite() || kotlin.math.abs(shift.toDouble()) > 1) return null
        }
      }
    }
    return value
  }

  /** Path commands the phone's glyphs use, nothing else. */
  private val pathData = Regex("^[MLAZ0-9 .-]{1,512}$")

  private fun validGlyph(glyph: JSONObject?): Boolean {
    val strokes = glyph?.optJSONArray("strokes") ?: return false
    val fills = glyph.optJSONArray("fills") ?: return false
    if (strokes.length() > 4 || fills.length() > 4) return false
    for (i in 0 until strokes.length()) {
      val stroke = strokes.optJSONObject(i) ?: return false
      if (!pathData.matches(stroke.optString("d"))) return false
      val width = stroke.opt("width") as? Number ?: return false
      if (!width.toDouble().isFinite() || width.toDouble() <= 0 || width.toDouble() > 6) return false
      if (stroke.has("opacity")) {
        val opacity = stroke.opt("opacity") as? Number ?: return false
        if (opacity.toDouble() !in 0.0..1.0) return false
      }
    }
    for (i in 0 until fills.length()) {
      if (!pathData.matches(fills.opt(i) as? String ?: return false)) return false
    }
    return true
  }
}
