import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { QueryProvider } from "@/providers/QueryProvider";

import "../../global.css";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: "#020617" },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="history" />
            <Stack.Screen name="player" options={{ presentation: "modal" }} />
          </Stack>
        </QueryProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
