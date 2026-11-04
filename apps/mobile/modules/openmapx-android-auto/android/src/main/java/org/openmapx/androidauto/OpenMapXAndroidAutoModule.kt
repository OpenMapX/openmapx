package org.openmapx.androidauto

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/** Bounded Expo transport between the shared JS authority and connected car sessions. */
class OpenMapXAndroidAutoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenMapXAndroidAuto")
    Events("onCommand")
    AsyncFunction("isConnected") { CarState.connected }.runOnQueue(Queues.MAIN)
    AsyncFunction("startEligible") { appContext.currentActivity?.hasWindowFocus() == true }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("destinations") { json: String ->
        require(json.toByteArray().size <= 64 * 1024)
        val value = JSONObject(json)
        if (CarState.destinations.optString("account") != value.optString("account")) {
          CarState.result = JSONObject()
          CarState.preview =
            JSONObject().put("v", 1).put("type", "car-preview").put("routes", org.json.JSONArray())
          CarState.command("destinations-changed")
        }
        CarState.destinations = value
        CarState.locale =
          (CarState.projection ?: CarState.destinations).optString("locale", CarState.locale)
        CarState.units =
          (CarState.projection ?: CarState.destinations).optString("units", CarState.units)
        CarState.changed()
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("result") { json: String ->
        require(json.toByteArray().size <= 64 * 1024)
        CarState.result = JSONObject(json)
        CarState.changed()
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("runtimeReady") {
        android.util.Log.i(
          "OpenMapXCar",
          "car coordinator composed; activityPresent=${appContext.currentActivity != null}",
        )
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("configure") { origin: String, locale: String, units: String ->
        require(locale in listOf("en", "de") && units in listOf("metric", "imperial"))
        CarState.locale = locale
        CarState.units = units
        val uri = android.net.Uri.parse(origin)
        require(
          uri.scheme in listOf("https", "http") && uri.host != null && uri.path.isNullOrEmpty()
        )
        CarState.origin = origin
        CarState.changed()
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("publish") { json: String ->
        require(json.toByteArray().size <= 8 * 1024 * 1024)
        val value = JSONObject(json)
        CarState.projection = CarProjection.parse(value.optJSONObject("projection"))
        CarState.snapshot = value.optJSONObject("message")
        CarState.projection?.let {
          CarState.locale = it.optString("locale", CarState.locale)
          CarState.units = it.optString("units", CarState.units)
        }
        CarState.changed()
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("preview") { json: String ->
        require(json.toByteArray().size <= 8 * 1024 * 1024)
        CarState.preview = JSONObject(json)
        CarState.changed()
      }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("acknowledge") { command: String -> CarState.acknowledge(command) }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("detach") { CarState.listener = null }.runOnQueue(Queues.MAIN)
    AsyncFunction("attach") {
        CarState.listener = { sendEvent("onCommand", mapOf("command" to it)) }
        CarState.drain()
        CarState.command("attach")
      }
      .runOnQueue(Queues.MAIN)
    OnDestroy { CarState.listener = null }
  }
}
