/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      config: "e2e/jest.config.js",
      _: ["e2e"],
    },
  },
  apps: {
    "ios.debug": {
      type: "ios.app",
      binaryPath: "ios/build/Build/Products/Debug-iphonesimulator/OpenMapX.app",
      build:
        "cd ios && xcodebuild -workspace OpenMapX.xcworkspace -scheme OpenMapX -configuration Debug -sdk iphonesimulator -derivedDataPath build",
    },
    "android.debug": {
      type: "android.apk",
      binaryPath: "android/app/build/outputs/apk/debug/app-debug.apk",
      build: "cd android && ./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug",
    },
  },
  devices: {
    simulator: {
      type: "ios.simulator",
      device: { type: "iPhone 16" },
    },
    emulator: {
      type: "android.emulator",
      device: { avdName: "Pixel_7_API_35" },
    },
  },
  configurations: {
    "ios.sim.debug": {
      device: "simulator",
      app: "ios.debug",
    },
    "android.emu.debug": {
      device: "emulator",
      app: "android.debug",
    },
  },
};
