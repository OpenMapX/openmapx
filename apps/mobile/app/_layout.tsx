import "../src/lib/i18n";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Slot } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { initPlatform } from "../src/lib/config";
import "react-native-reanimated";
import { MapCanvas } from "../src/components/map/MapCanvas";
import { StreetViewViewer } from "../src/components/map/StreetViewViewer";
import { ElevationHoverProvider } from "../src/lib/ElevationHoverContext";
import { MapProvider } from "../src/lib/MapContext";
import { useRouterSidebarSync } from "../src/lib/routerSidebarSync";
import { IntegrationProvider } from "../src/providers/IntegrationProvider";

import "../global.css";

initPlatform();
SplashScreen.preventAutoHideAsync();

const lightTheme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#007b8b",
    secondary: "#34A853",
  },
};

const darkTheme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#4db6c4",
    secondary: "#34A853",
  },
};

function RouterSync() {
  useRouterSidebarSync();
  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = useMemo(() => (colorScheme === "dark" ? darkTheme : lightTheme), [colorScheme]);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60_000, retry: 1, gcTime: 24 * 60 * 60 * 1000 },
        },
      }),
  );

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <BottomSheetModalProvider>
          <QueryClientProvider client={queryClient}>
            <PaperProvider theme={theme}>
              <IntegrationProvider>
                <MapProvider>
                  <ElevationHoverProvider>
                    <MapCanvas />
                    <RouterSync />
                    <View pointerEvents="box-none" style={StyleSheet.absoluteFillObject}>
                      <Slot />
                    </View>
                    <StreetViewViewer />
                  </ElevationHoverProvider>
                </MapProvider>
              </IntegrationProvider>
            </PaperProvider>
          </QueryClientProvider>
        </BottomSheetModalProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
