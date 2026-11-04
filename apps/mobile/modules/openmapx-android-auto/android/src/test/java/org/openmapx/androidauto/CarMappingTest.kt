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
  @Test
  fun maneuverTable() {
    val cases =
      mapOf(
        "straight" to Maneuver.TYPE_STRAIGHT,
        "left" to Maneuver.TYPE_TURN_NORMAL_LEFT,
        "right" to Maneuver.TYPE_TURN_NORMAL_RIGHT,
        "slight-left" to Maneuver.TYPE_TURN_SLIGHT_LEFT,
        "slight-right" to Maneuver.TYPE_TURN_SLIGHT_RIGHT,
        "keep-left" to Maneuver.TYPE_KEEP_LEFT,
        "keep-right" to Maneuver.TYPE_KEEP_RIGHT,
        "sharp-left" to Maneuver.TYPE_TURN_SHARP_LEFT,
        "sharp-right" to Maneuver.TYPE_TURN_SHARP_RIGHT,
        "uturn-left" to Maneuver.TYPE_U_TURN_LEFT,
        "uturn-right" to Maneuver.TYPE_U_TURN_RIGHT,
        "arrive" to Maneuver.TYPE_DESTINATION,
        "roundabout" to Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW,
        "roundabout-cw" to Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW,
        "unknown" to Maneuver.TYPE_STRAIGHT,
      )
    for ((name, type) in cases) {
      val step =
        CarTripMapper.step(RuntimeEnvironment.getApplication(), 
          JSONObject().put("instruction", "Continue").put("maneuver", name).put("exit", 3)
        )
      assertEquals(name, type, step.maneuver!!.type)
      assertNotNull("$name has a routing-card icon", step.maneuver!!.icon)
      if (name.startsWith("roundabout")) assertEquals(3, step.maneuver!!.roundaboutExitNumber)
    }
  }

  @Test
  fun distanceUnitsAndInvalidValues() {
    assertEquals(Distance.UNIT_FEET, CarTripMapper.distance(100.0, "imperial").displayUnit)
    assertEquals(1.0, CarTripMapper.distance(1609.344, "imperial").displayDistance, 0.0001)
    assertEquals(Distance.UNIT_MILES_P1, CarTripMapper.distance(1609.344, "imperial").displayUnit)
    assertEquals(Distance.UNIT_KILOMETERS_P1, CarTripMapper.distance(2000.0, "metric").displayUnit)
    assertEquals(Distance.UNIT_KILOMETERS, CarTripMapper.distance(23400.0, "metric").displayUnit)
    assertEquals(0.0, CarTripMapper.distance(Double.NaN).displayDistance, 0.0)
    assertEquals(0.0, CarTripMapper.distance(-1.0).displayDistance, 0.0)
    val previous = java.util.Locale.getDefault()
    java.util.Locale.setDefault(java.util.Locale.GERMANY)
    try {
      val p = JSONObject().put("distanceToManeuver", 1500).put("locale", "en").put("units", "metric")
      // The rail matches the host's routing card, which follows the phone's locale.
      assertEquals("1,5 km", GuidanceNotification.distanceText(p))
    } finally {
      java.util.Locale.setDefault(previous)
    }
  }

  @Test
  fun guidanceDistancesAreRounded() {
    assertEquals(600.0, CarTripMapper.distance(614.8, "metric").displayDistance, 0.0)
    assertEquals(90.0, CarTripMapper.distance(87.0, "metric").displayDistance, 0.0)
    assertEquals(3.3, CarTripMapper.distance(3312.0, "metric").displayDistance, 0.0)
    assertEquals(Distance.UNIT_KILOMETERS_P1, CarTripMapper.distance(960.0, "metric").displayUnit)
    assertEquals(500.0, CarTripMapper.distance(152.4, "imperial").displayDistance, 0.0)
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
        .put("maneuver", "right")
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
        .put("maneuver", "keep-left")
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
