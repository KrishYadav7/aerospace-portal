#!/usr/bin/env bash
# AeroGyan Store on an Android 14 emulator, end to end (run by store-android.yml, job "emulator").
# A debug build reads a fake catalogue from the runner (http://10.0.2.2:8765/api/store, ci/emulator/api/store)
# whose files are the REAL live ones on aerogyan.tech / medico.aerogyan.tech:
#   • first run: welcome screen, role → the list (English), then Hindi
#   • Install AeroGyan: download from aerogyan.tech → SHA-256 + signing key (pinned) → PackageInstaller → the
#     system dialog → installed, installer of record = the store
#   • Jivan Medico with a WRONG SHA-256 in the catalogue: downloaded, refused, not installed
#   • no crash
# Writes test-out/report.txt; exits 1 on a failed check.
set -u
OUT=test-out; mkdir -p "$OUT"; R="$OUT/report.txt"; : > "$R"
PKG=tech.aerogyan.store
UI="python3 store-app/android/ci/ui.py"
FAILS=0
pass() { echo "PASS  $*" | tee -a "$R"; }
fail() { echo "FAIL  $*" | tee -a "$R"; FAILS=$((FAILS+1)); }
info() { echo "....  $*" | tee -a "$R"; }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }

# the fake catalogue (the emulator reaches the runner as 10.0.2.2)
python3 -m http.server 8765 --bind 0.0.0.0 --directory store-app/android/ci/emulator > "$OUT/http.log" 2>&1 &
sleep 2
curl -sf http://127.0.0.1:8765/api/store > /dev/null && pass "test catalogue served" || fail "test catalogue not served"

adb wait-for-device
info "Android $(adb shell getprop ro.build.version.release | tr -d '\r') · $(adb shell getprop ro.product.model | tr -d '\r')"
adb install -r store-debug.apk > "$OUT/install.txt" 2>&1 && pass "store installs" || { fail "store does not install: $(tail -1 $OUT/install.txt)"; exit 1; }
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb logcat -c

# ---- first run
adb shell am start -W -n $PKG/.MainActivity > /dev/null 2>&1
sleep 6
$UI wait "Welcome to AeroGyan Store" 30 && pass "welcome screen" || fail "no welcome screen"
shot 01-welcome
$UI tap "Student" && sleep 1
$UI tap "Continue" && sleep 3
$UI wait "Jivan Medico" 40 && pass "catalogue loads (For you, student)" || fail "the list did not load"
$UI dump 02-list; shot 02-list
grep -q "^AeroGyan " "$OUT/02-list.txt" && pass "AeroGyan is listed" || fail "AeroGyan missing from For you"
grep -qi "Needs a computer\|Open in browser" "$OUT/02-list.txt" && pass "Drishya says it needs a computer" || fail "Drishya web-only line missing"
grep -q "Install" "$OUT/02-list.txt" && pass "Install buttons" || fail "no Install button"

# ---- the tampered file is refused
$UI tap "Jivan Medico" && sleep 2
$UI tap "Install" && info "Jivan Medico: Install tapped"
sleep 3
$UI dump 03-allow
if grep -qi "Allow installs from AeroGyan Store" "$OUT/03-allow.txt"; then
  pass "first install asks for 'Allow from this source' with guidance"
  shot 03-allow
  adb shell appops set $PKG REQUEST_INSTALL_PACKAGES allow
  $UI tap "Open settings"; sleep 3; adb shell input keyevent KEYCODE_BACK; sleep 3
else
  info "no allow dialog (permission already given?)"
  adb shell appops set $PKG REQUEST_INSTALL_PACKAGES allow
fi
$UI wait "Refused" 90 && pass "tampered Jivan Medico (wrong SHA-256) is REFUSED" || fail "the tampered file was not refused"
$UI dump 04-refused; shot 04-refused
grep -h "Refused" "$OUT/04-refused.txt" | head -2 | sed 's/^/....  /' | tee -a "$R"
adb shell pm list packages | grep -q "tech.aerogyan.medico" && fail "Jivan Medico got installed!" || pass "Jivan Medico not installed"
adb shell input keyevent KEYCODE_BACK; sleep 2

# ---- a real install: AeroGyan (verified against the pinned key)
$UI tap "AeroGyan" && sleep 2
$UI tap "Install" && info "AeroGyan: Install tapped"
OK=0
for i in $(seq 1 40); do
  sleep 3
  $UI dump inst > /dev/null
  if grep -qi "packageinstaller" "$OUT/inst.txt"; then
    shot 05-system-dialog
    python3 store-app/android/ci/ui.py tap "Install" packageinstaller && info "system dialog: Install tapped"
    sleep 6
  fi
  if adb shell pm list packages | grep -q "^package:tech.aerogyan.app$"; then OK=1; break; fi
done
[ $OK = 1 ] && pass "AeroGyan downloaded, verified and installed" || fail "AeroGyan was not installed"
INST=$(adb shell dumpsys package tech.aerogyan.app | grep -m1 "installerPackageName" | tr -d '\r' | xargs)
info "AeroGyan: $INST"
echo "$INST" | grep -q "$PKG" && pass "installer of record is the store (silent updates possible)" || info "installer of record is not the store"
sleep 3; $UI dump 06-after; shot 06-after
grep -q "Open" "$OUT/06-after.txt" && pass "the button now says Open" || fail "no Open button after install"
adb shell input keyevent KEYCODE_BACK; sleep 1

# ---- Hindi
if [ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" -ge 33 ]; then
  adb shell cmd locale set-app-locales $PKG --locales hi > /dev/null 2>&1 || true
  sleep 3; adb shell am force-stop $PKG; adb shell am start -W -n $PKG/.MainActivity > /dev/null 2>&1; sleep 6
  $UI wait "आपके लिए" 30 && pass "Hindi: 'आपके लिए' tab" || fail "Hindi strings not shown"
  $UI dump 07-hindi; shot 07-hindi
  grep -q "एरोज्ञान" "$OUT/07-hindi.txt" && pass "Hindi app names" || fail "Hindi names missing"
fi

adb logcat -d > "$OUT/logcat.txt"
if grep -q "FATAL EXCEPTION.*" "$OUT/logcat.txt" && grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "$PKG"; then
  fail "the store CRASHED"; grep -A20 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -40 >> "$R"
else
  pass "no crash"
fi
grep -E "AeroGyanStore|tech.aerogyan.store" "$OUT/logcat.txt" | tail -40 > "$OUT/logcat-store.txt" || true
echo "RESULT: $FAILS failed" | tee -a "$R"
[ $FAILS = 0 ]
