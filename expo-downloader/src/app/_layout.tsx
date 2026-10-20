import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { QueryProvider } from "@/providers/QueryProvider";
import { initializeDatabase } from "@/db/database";
import { recoverDownloads } from "@/features/downloads/downloadManager";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      try {
        await initializeDatabase();
        await recoverDownloads();

        if (mounted) setReady(true);
      } catch (error) {
        if (mounted) {
          setError(
            error instanceof Error
              ? error.message
              : "App initialization failed",
          );
        }
      }
    }

    void initialize();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <QueryProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </QueryProvider>
  );
}