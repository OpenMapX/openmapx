package org.openmapx.androidauto

import android.content.Intent
import android.net.Uri
import androidx.car.app.model.Distance
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.testing.TestCarContext
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Pure trip metadata, bounded host templates and connection notification contracts. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CarMappingTest {
  private fun parts(value: Double, unit: String, decimals: Int) =
    JSONObject().put("value", value).put("unit", unit).put("decimals", decimals)

  @Test
  fun hostTurnTypesFollowThePhoneGlyph() {
    val cases =
      mapOf(
        "Straight" to Maneuver.TYPE_STRAIGHT,
        "TurnLeft" to Maneuver.TYPE_TURN_NORMAL_LEFT,
        "TurnRight" to Maneuver.TYPE_TURN_NORMAL_RIGHT,
        "TurnSlightLeft" to Maneuver.TYPE_TURN_SLIGHT_LEFT,
        "TurnSlightRight" to Maneuver.TYPE_TURN_SLIGHT_RIGHT,
        "TurnSharpLeft" to Maneuver.TYPE_TURN_SHARP_LEFT,
        "TurnSharpRight" to Maneuver.TYPE_TURN_SHARP_RIGHT,
        "UTurnLeft" to Maneuver.TYPE_U_TURN_LEFT,
        "MergeType" to Maneuver.TYPE_MERGE_SIDE_UNSPECIFIED,
        "Flag" to Maneuver.TYPE_DESTINATION,
        "unknown" to Maneuver.TYPE_STRAIGHT,
      )
    val context = RuntimeEnvironment.getApplication()
    for ((icon, type) in cases) {
      val step =
        CarTripMapper.step(context, JSONObject().put("instruction", "Continue").put("maneuverIcon", icon))
      assertEquals(icon, type, step.maneuver!!.type)
      assertNotNull("$icon has a routing-card icon", step.maneuver!!.icon)
    }
    val roundabout =
      CarTripMapper.step(
        context,
        JSONObject()
          .put("instruction", "Take the 3rd exit")
          .put("maneuverIcon", "RoundaboutRight")
          .put("roundabout", JSONObject().put("exit", 3).put("clockwise", false)),
      )
    assertEquals(Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW, roundabout.maneuver!!.type)
    assertEquals(3, roundabout.maneuver!!.roundaboutExitNumber)
  }

  @Test
  fun sharedDistancesMapToHostUnits() {
    assertEquals(Distance.UNIT_METERS, CarTripMapper.distance(parts(615.0, "m", 0)).displayUnit)
    assertEquals(615.0, CarTripMapper.distance(parts(615.0, "m", 0)).displayDistance, 0.0)
    assertEquals(Distance.UNIT_KILOMETERS_P1, CarTripMapper.distance(parts(3.3, "km", 1)).displayUnit)
    assertEquals(Distance.UNIT_KILOMETERS, CarTripMapper.distance(parts(23.0, "km", 0)).displayUnit)
    assertEquals(Distance.UNIT_FEET, CarTripMapper.distance(parts(984.0, "ft", 0)).displayUnit)
    assertEquals(Distance.UNIT_MILES_P1, CarTripMapper.distance(parts(1.24, "mi", 2)).displayUnit)
    assertEquals(0.0, CarTripMapper.distance(null).displayDistance, 0.0)
    val previous = java.util.Locale.getDefault()
    java.util.Locale.setDefault(java.util.Locale.GERMANY)
    try {
      // The rail matches the host's routing card, which follows the phone's locale.
      val p = JSONObject().put("maneuverDistance", parts(1.5, "km", 1))
      assertEquals("1,5 km", GuidanceNotification.distanceText(p))
    } finally {
      java.util.Locale.setDefault(previous)
    }
  }

  @Test
  fun phoneGlyphsDrawAndUnknownNamesAreRejected() {
    val context = RuntimeEnvironment.getApplication()
    for (name in ManeuverIcons.names) assertEquals(128, ManeuverIcons.bitmap(context, name).width)
    val p =
      JSONObject()
        .put("sessionId", "s")
        .put("instruction", "Continue")
        .put("locale", "de")
        .put("units", "metric")
        .put("maneuverIcon", "TurnLeft")
        .put("maneuverDistance", parts(1.0, "m", 0))
        .put("remainingDistanceDisplay", parts(1.0, "m", 0))
    for (key in
      listOf(
        "revision",
        "distanceToManeuver",
        "secondsToManeuver",
        "maneuverEtaMs",
        "remainingDistance",
        "remainingSeconds",
        "etaMs",
      )) p.put(key, 1)
    assertNotNull(CarProjection.parse(p))
    assertNull(CarProjection.parse(JSONObject(p.toString()).put("maneuverIcon", "Rocket")))
    assertNull(
      CarProjection.parse(JSONObject(p.toString()).put("maneuverDistance", parts(1.0, "furlong", 0)))
    )
  }

  @Test
  fun unmarkedLaneStripsAddNoImage() {
    val blank =
      org.json.JSONArray().put(JSONObject().put("valid", true).put("arrows", org.json.JSONArray()))
    assertTrue(!LaneImage.hasArrows(blank))
    val step =
      CarTripMapper.step(RuntimeEnvironment.getApplication(), 
        JSONObject().put("instruction", "Keep left").put("maneuverIcon", "TurnSlightLeft").put("lanes", blank)
      )
    assertNull(step.lanesImage)
  }

  @Test
  fun destinationsAndSearchTemplatesAreValidWhenEmpty() {
    val context = TestCarContext.createCarContext(RuntimeEnvironment.getApplication())
    assertNotNull(DestinationsScreen(context).onGetTemplate())
    assertNotNull(DestinationsScreen(context, true).onGetTemplate())
    // Building validates every host constraint the car would otherwise crash on.
    val routes =
      org.json
        .JSONArray()
        .put(JSONObject().put("durationSeconds", 23580).put("distanceMeters", 637300))
        .put(JSONObject().put("durationSeconds", 24000).put("distanceMeters", 640000))
    val preview =
      PreviewScreen(context, routes).onGetTemplate()
        as androidx.car.app.navigation.model.MapWithContentTemplate
    assertEquals(listOf("A", "B", "C"), (0..2).map(RouteBadge::letter))
    // Start must be in the action strip: the host draws no action below a list here.
    assertEquals(1, preview.actionStrip!!.actions.size)
    // Replacing a running trip asks first, with its own Start.
    CarState.projection = JSONObject().put("sessionId", "running")
    try {
      val screen = PreviewScreen(context, routes)
      screen.onGetTemplate()
      assertNotNull(screen)
    } finally {
      CarState.projection = null
    }
    for (code in listOf("phone-setup", "location-unavailable", "no-route", "network", "other")) {
      CarState.result = JSONObject().put("error", code)
      assertNotNull(PreviewScreen(context, routes).onGetTemplate())
    }
    CarState.result = JSONObject()
  }

  @Test
  fun navigationIntentsValidateWgs84() {
    for (uri in listOf("geo:52.5,13.4", "google.navigation:q=52.5,13.4")) {
      val destination = CarNavigationIntent.destination(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
      assertNotNull(destination)
      assertEquals(13.4, destination!!.getJSONArray("coordinates").getDouble(0), 0.0)
    }
    assertNull(CarNavigationIntent.destination(Intent(Intent.ACTION_VIEW, Uri.parse("geo:91,13"))))
  }

  @Test
  fun hostStopIsDeliveredOnceUntilAcknowledged() {
    var stops = 0
    CarState.acknowledge("stop")
    CarState.listener = { if (it == "stop") stops++ }
    try {
      CarState.command("stop")
      CarState.command("stop")
      assertEquals(1, stops)
    } finally {
      CarState.listener = null
      CarState.acknowledge("stop")
    }
  }

  @Test
  fun projectionParserRejectsMalformedFieldsAndLaneBounds() {
    val p =
      JSONObject()
        .put("sessionId", "s")
        .put("instruction", "Continue")
        .put("locale", "de")
        .put("units", "metric")
        .put("maneuverIcon", "Straight")
        .put("maneuverDistance", parts(1.0, "m", 0))
        .put("remainingDistanceDisplay", parts(1.0, "m", 0))
    for (key in
      listOf(
        "revision",
        "distanceToManeuver",
        "secondsToManeuver",
        "maneuverEtaMs",
        "remainingDistance",
        "remainingSeconds",
        "etaMs",
      )) p.put(key, 1)
    assertNotNull(CarProjection.parse(p))
    assertNull(CarProjection.parse(JSONObject(p.toString()).put("remainingSeconds", -1)))
    assertNull(CarProjection.parse(JSONObject(p.toString()).put("units", "unknown")))
    assertNull(CarProjection.parse(JSONObject(p.toString()).put("instruction", "")))
    val lanes = org.json.JSONArray()
    repeat(13) {
      lanes.put(JSONObject().put("arrows", org.json.JSONArray()).put("valid", true))
    }
    assertNull(CarProjection.parse(JSONObject(p.toString()).put("lanes", lanes)))
  }

  @Test
  fun lanesAndTravelEstimateRemainNativeMetadata() {
    val p =
      JSONObject()
        .put("instruction", "Turn right")
        .put("maneuverIcon", "TurnRight")
        .put("remainingDistance", 1000)
        .put("remainingSeconds", 60)
        .put("etaMs", 1700000000000)
        .put("maneuverIcon", "TurnRight")
        .put(
          "lanes",
          org.json
            .JSONArray()
            .put(
              JSONObject()
                .put("valid", true)
                .put(
                  "arrows",
                  org.json
                    .JSONArray()
                    .put(JSONObject().put("icon", "Straight").put("active", false).put("stemShift", 0))
                    .put(
                      JSONObject().put("icon", "TurnRight").put("active", true).put("stemShift", 1.0 / 6)
                    ),
                )
            ),
        )
    val step = CarTripMapper.step(RuntimeEnvironment.getApplication(), p)
    assertEquals(1, step.lanes.size)
    assertEquals(2, step.lanes[0].directions.size)
    // The recommended arrow is the active one, as on the phone.
    assertTrue(step.lanes[0].directions.single { it.isRecommended }.shape == androidx.car.app.navigation.model.LaneDirection.SHAPE_NORMAL_RIGHT)
    assertNotNull(step.lanesImage)
    assertEquals(60L, CarTripMapper.estimate(p).remainingTimeSeconds)
  }

  @Test
  fun navigationTemplatesKeepMapControlsWithinHostLimits() {
    val context = TestCarContext.createCarContext(RuntimeEnvironment.getApplication())
    CarState.projection = null
    assertNotNull(NavigationScreen(context).onGetTemplate())
    CarState.projection =
      JSONObject()
        .put("sessionId", "s")
        .put("instruction", "Keep left")
        .put("maneuverIcon", "TurnSlightLeft")
        .put("distanceToManeuver", 3312)
        .put("remainingDistance", 572000)
        .put("remainingSeconds", 21180)
        .put("etaMs", 1700000000000)
        .put("locale", "en")
        .put("units", "metric")
    try {
      val template =
        NavigationScreen(context).onGetTemplate()
          as androidx.car.app.navigation.model.NavigationTemplate
      // No Stop of our own during a trip: the host's X ends it through onStopNavigation.
      assertEquals(
        listOf("Destinations"),
        template.actionStrip!!.actions.mapNotNull { it.title?.toString() }.filter { it != "Test drive" },
      )
      val actions = template.mapActionStrip!!.actions
      assertEquals(4, actions.size)
      assertTrue(
        actions.filter { it.type != androidx.car.app.model.Action.TYPE_PAN }.all {
          it.flags and androidx.car.app.model.Action.FLAG_IS_PERSISTENT != 0
        }
      )
    } finally {
      CarState.projection = null
    }
  }

  @Test
  fun testDriveModeOffersAReachableGermanDestination() {
    val context = TestCarContext.createCarContext(RuntimeEnvironment.getApplication())
    fun titles() =
      ((DestinationsScreen(context).onGetTemplate() as androidx.car.app.model.ListTemplate)
          .singleList!!
          .items)
        .map { (it as androidx.car.app.model.Row).title.toString() }
    assertTrue(titles().none { it.contains("Brandenburg") })
    CarState.autoDrive = true
    try {
      assertTrue(titles().any { it.contains("Brandenburg") })
      val place = AutoDrive.destination("Test")
      assertEquals(13.3777, place.getJSONArray("coordinates").getDouble(0), 0.0)
    } finally {
      CarState.autoDrive = false
    }
  }

  private fun card(sessionId: String = "s") = JSONObject().put("sessionId", sessionId)

  private fun projection() =
    JSONObject()
      .put("sessionId", "s")
      .put("maneuverId", "s:3")
      .put("instruction", "Turn right")
      .put("maneuverIcon", "TurnRight")
      .put("distanceToManeuver", 200)
      .put("maneuverDistance", parts(200.0, "m", 0))
      .put("locale", "en")
      .put("units", "metric")

  private fun decorated(): android.app.Notification {
    val context = RuntimeEnvironment.getApplication()
    val builder =
      android.app.Notification.Builder(context, "test")
        .setSmallIcon(android.R.drawable.ic_dialog_map)
        .setOnlyAlertOnce(true)
    GuidanceNotification.decorate(context, card(), builder)
    return builder.build()
  }

  @Test
  fun carExtendsThePhoneNavigationCardInsteadOfPostingItsOwn() {
    CarState.connected = true
    CarState.projection = projection()
    try {
      val notification = decorated()
      assertTrue(androidx.car.app.notification.CarAppExtender.isExtended(notification))
      val car = androidx.car.app.notification.CarAppExtender(notification)
      assertEquals("Turn right", car.contentTitle)
      assertEquals("200 m", car.contentText)
      assertNotNull(car.largeIcon)
      // A new turn alerts in the car; the same turn again only updates the rail.
      assertEquals(android.app.NotificationManager.IMPORTANCE_HIGH, car.importance)
      val again = androidx.car.app.notification.CarAppExtender(decorated())
      assertEquals(android.app.NotificationManager.IMPORTANCE_LOW, again.importance)
    } finally {
      CarState.connected = false
      CarState.projection = null
    }
  }

  @Test
  fun noCarExtensionWithoutAConnectedCarOrForAnotherTrip() {
    CarState.connected = false
    CarState.projection = projection()
    try {
      assertTrue(!androidx.car.app.notification.CarAppExtender.isExtended(decorated()))
      CarState.connected = true
      val context = RuntimeEnvironment.getApplication()
      val builder =
        android.app.Notification.Builder(context, "test").setSmallIcon(android.R.drawable.ic_dialog_map)
      GuidanceNotification.decorate(context, card("other-trip"), builder)
      assertTrue(!androidx.car.app.notification.CarAppExtender.isExtended(builder.build()))
    } finally {
      CarState.connected = false
      CarState.projection = null
    }
  }

  @Test
  fun turnsDoNotPopUpWhileOpenMapXIsOnTheCarScreen() {
    CarState.connected = true
    CarState.visible = true
    CarState.projection = projection().put("maneuverId", "s:9")
    try {
      val car = androidx.car.app.notification.CarAppExtender(decorated())
      assertEquals(android.app.NotificationManager.IMPORTANCE_LOW, car.importance)
    } finally {
      CarState.visible = false
      CarState.connected = false
      CarState.projection = null
    }
  }
}
