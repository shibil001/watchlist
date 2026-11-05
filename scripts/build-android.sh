#!/usr/bin/env bash
# Builds dist-android/watchlist-Android.apk on a Mac.
# Needs Java 21 and the Android SDK: either Android Studio, or the lighter Homebrew route (see the messages below).
set -euo pipefail
cd "$(dirname "$0")/.."

# Java 21: JAVA_HOME if set, else the Java inside Android Studio, else a JDK 21 installed on the Mac.
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  elif JH="$(/usr/libexec/java_home -v 21 2>/dev/null)"; then
    export JAVA_HOME="$JH"
  fi
fi
if [ -z "${JAVA_HOME:-}" ]; then
  echo "Java 21 not found."
  echo "Easiest fix:  brew install --cask temurin@21     (or install Android Studio)"
  exit 1
fi

# Android SDK: ANDROID_HOME if set, else Android Studio's folder, else the Homebrew command-line tools.
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Library/Android/sdk" "/opt/homebrew/share/android-commandlinetools" "/usr/local/share/android-commandlinetools"; do
    if [ -d "$d" ]; then ANDROID_HOME="$d"; break; fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME" ]; then
  echo "Android SDK not found."
  echo "Easiest fix:  brew install --cask android-commandlinetools"
  echo "then:         yes | sdkmanager --licenses"
  echo "              sdkmanager \"platforms;android-36\" \"build-tools;36.0.0\""
  exit 1
fi
export ANDROID_HOME

node scripts/build-web.js
[ -d android ] || npx cap add android
cp -R android-res/. android/app/src/main/res/      # Watchlist icon + splash
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
npx cap sync android

# Android 13+ asks before showing notifications; the app must declare it (reminders for airing shows).
MF=android/app/src/main/AndroidManifest.xml
grep -q POST_NOTIFICATIONS "$MF" || perl -0pi -e 's#<application#<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <application#' "$MF"

# Slow or unstable internet: smaller Gradle download and much longer timeouts.
WP=android/gradle/wrapper/gradle-wrapper.properties
sed -i.bak -e 's/^networkTimeout=.*/networkTimeout=300000/' -e 's/-all\.zip/-bin.zip/' "$WP" && rm -f "$WP.bak"
GP=android/gradle.properties
grep -q 'internal.http.connectionTimeout' "$GP" || printf '\norg.gradle.internal.http.connectionTimeout=180000\norg.gradle.internal.http.socketTimeout=180000\n' >> "$GP"

( cd android && ./gradlew assembleDebug )

mkdir -p dist-android
cp android/app/build/outputs/apk/debug/app-debug.apk dist-android/watchlist-Android.apk
echo
echo "Done: $(pwd)/dist-android/watchlist-Android.apk"
