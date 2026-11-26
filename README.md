# Evilfy for Android

The desktop Evilfy UI wrapped with Capacitor. `src/shim.js` replaces Electron's `main.js`/`preload.js`.

## Build the APK in the VS Code terminal

You need: **Node 22+**, **JDK 21**, and the **Android SDK** (easiest: install Android Studio once, open it, let it download the SDK).

1. Set `ANDROID_HOME` to the SDK folder (Windows default: `%LOCALAPPDATA%\Android\Sdk`) and make sure `java -version` says 21.
2. In this folder:

       npm install
       npm run apk

3. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to your phone and open it (allow "install unknown apps").

No local Android setup? Push this folder to a GitHub repo. The **Build Android APK** workflow (Actions tab) builds it and uploads `Evilfy-debug-apk` as a download.

## After editing the UI

Edit files in `web/` (UI) or `src/shim.js` (Android layer), then run `npm run apk` again.

## Differences from desktop

- Songs are copied into the app's private storage when added (this is what keeps them playable after a restart). Delete the app and they go with it.
- "Add folder" is replaced by multi-select in "Add songs"; mini player, Discord presence, volume slider are hidden (use the phone's volume keys).
- "Show in folder" became "Share file". Recordings are saved inside the app; use Share file to get them out.
- Playlist import matches songs by file name against your library.
