package tech.aerogyan.store.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val Light = lightColorScheme(
    primary = Color(0xFF4F46E5),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0E0FF),
    onPrimaryContainer = Color(0xFF14105C),
    secondary = Color(0xFF5B5D72),
    tertiary = Color(0xFF0B7A68),
    background = Color(0xFFFBFBFE),
    surface = Color(0xFFFBFBFE),
    error = Color(0xFFB3261E),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFA5B4FC),
    onPrimary = Color(0xFF1E1B6B),
    primaryContainer = Color(0xFF3730A3),
    onPrimaryContainer = Color(0xFFE0E0FF),
    secondary = Color(0xFFC4C5DD),
    tertiary = Color(0xFF5EEAD4),
    background = Color(0xFF121318),
    surface = Color(0xFF121318),
    error = Color(0xFFF2B8B5),
)

/** Material 3: the phone's own colours on Android 12+ (dynamic colour), AeroGyan indigo before; dark mode follows the phone. */
@Composable
fun StoreTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val ctx = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> Dark
        else -> Light
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
