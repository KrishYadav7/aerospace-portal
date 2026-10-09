# Plain Java app with no reflection — the default Android rules are enough,
# plus: the JavaScript bridges are called by name from the web page.
-keep class tech.aerogyan.app.MainActivity { *; }
-keepclassmembers class tech.aerogyan.app.MainActivity$* {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
