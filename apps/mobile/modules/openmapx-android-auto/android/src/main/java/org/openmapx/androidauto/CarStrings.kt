package org.openmapx.androidauto

import android.content.res.Configuration
import androidx.car.app.CarContext
import java.util.Locale

/** Uses the user's shell/session locale independently of the head unit's language. */
fun CarContext.carString(id: Int, vararg args: Any): String {
  val configuration = Configuration(resources.configuration)
  configuration.setLocale(Locale.forLanguageTag(CarState.locale))
  return createConfigurationContext(configuration).getString(id, *args)
}
