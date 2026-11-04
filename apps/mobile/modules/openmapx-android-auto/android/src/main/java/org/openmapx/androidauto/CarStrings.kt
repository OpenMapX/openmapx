package org.openmapx.androidauto

import android.content.res.Configuration
import androidx.car.app.CarContext
import androidx.car.app.model.CarIcon
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.graphics.drawable.toBitmap
import java.util.Locale

/** Uses the user's shell/session locale independently of the head unit's language. */
fun CarContext.carString(id: Int, vararg args: Any): String {
  val configuration = Configuration(resources.configuration)
  configuration.setLocale(Locale.forLanguageTag(CarState.locale))
  return createConfigurationContext(configuration).getString(id, *args)
}

/**
 * A drawable sent as pixels. Android Auto caches resource icons by resource ID across app
 * updates, so a resource icon can show a previous build's image after an update.
 */
fun CarContext.carIcon(id: Int): CarIcon {
  val drawable = requireNotNull(ContextCompat.getDrawable(this, id))
  return CarIcon.Builder(IconCompat.createWithBitmap(drawable.toBitmap(96, 96))).build()
}
