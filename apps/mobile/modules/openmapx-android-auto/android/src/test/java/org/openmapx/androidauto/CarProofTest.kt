package org.openmapx.androidauto

import android.graphics.Rect
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.testing.TestCarContext
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CarProofTest {
  @Test
  fun activeAndReroutingTemplatesAreValidInDebug() {
    val context =
      TestCarContext.createCarContext(org.robolectric.RuntimeEnvironment.getApplication())
    context.applicationInfo.flags =
      context.applicationInfo.flags or android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE
    val p =
      JSONObject()
        .put("instruction", "Turn right")
        .put("maneuver", "right")
        .put("remainingDistance", 200)
        .put("remainingSeconds", 20)
        .put("etaMs", 1700000000000)
    try {
      CarState.projection = p
      val screen = NavigationScreen(context)
      assertTrue(screen.onGetTemplate() is NavigationTemplate)
      p.put("rerouting", true)
      assertTrue(screen.onGetTemplate() is NavigationTemplate)
      assertTrue(CarTripMapper.trip(p, "Destination").isLoading)
    } finally {
      CarState.projection = null
    }
  }

  @Test
  fun cssInsetsAreEdgeDistances() {
    val value = CarViewport.insets(Rect(20, 10, 760, 440), 800, 480, 2f)
    assertEquals(10.0, value.getDouble("left"), 0.0)
    assertEquals(20.0, value.getDouble("bottom"), 0.0)
  }

  @Test
  fun idleTemplateIsValid() {
    val screen =
      NavigationScreen(
        TestCarContext.createCarContext(org.robolectric.RuntimeEnvironment.getApplication())
      )
    assertTrue(screen.onGetTemplate() is NavigationTemplate)
  }

  @Test
  fun unknownManeuverIsSafeAndRerouteKeepsTrip() {
    val p =
      JSONObject()
        .put("instruction", "Continue")
        .put("maneuver", "unknown")
        .put("remainingDistance", 200)
        .put("remainingSeconds", 20)
        .put("etaMs", 1700000000000)
    assertNotNull(CarTripMapper.trip(p, "Destination"))
  }
}
