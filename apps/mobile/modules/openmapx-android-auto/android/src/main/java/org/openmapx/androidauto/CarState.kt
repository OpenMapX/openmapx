package org.openmapx.androidauto

import org.json.JSONObject

/** Main-thread mailbox; a late JS listener drains commands rather than losing host stop. */
object CarState {
  var destinations = JSONObject()
  var result = JSONObject()
  var connected = false
  /** Android Auto's test-drive mode (`onAutoDriveEnabled`), until the car session ends. */
  var autoDrive = false
  /** OpenMapX is the app on the car screen (session started), not just connected. */
  var visible = false
  var locale = "en"
  var units = "metric"
  var projection: JSONObject? = null
  var snapshot: JSONObject? = null
  var preview: JSONObject =
    JSONObject().put("v", 1).put("type", "car-preview").put("routes", org.json.JSONArray())
  var origin: String? = null
  /** Camera commands for the one car map surface, for screens stacked above the map screen. */
  var camera: ((String, Array<out Pair<String, Number>>) -> Unit)? = null
  var listener: ((String) -> Unit)? = null
  private val pending = linkedSetOf<String>()
  val observers = mutableSetOf<() -> Unit>()

  /**
   * A new car session starts with an empty mailbox: commands an earlier session left
   * unacknowledged (its detach or stop) must not reach this one.
   */
  fun beginSession() {
    pending.clear()
    result = JSONObject()
  }

  fun command(command: String) {
    if (pending.add(command)) listener?.invoke(command)
  }

  fun drain() {
    pending.toList().forEach { listener?.invoke(it) }
  }

  fun acknowledge(command: String) {
    pending.remove(command)
  }

  fun changed() {
    observers.toList().forEach { it() }
  }
}
