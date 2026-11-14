import "../../global.css";

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { registerDownloadNotificationActions } from '../services/downloadManager';

export default function RootLayout() {
  useEffect(() => {
    let active = true;
    let responseSubscription: { remove: () => void } | undefined;

    void registerDownloadNotificationActions()
      .then((subscription) => {
        if (active) {
          responseSubscription = subscription;
        } else {
          subscription.remove();
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to initialize download notification actions.', error);
      });

    return () => {
      active = false;
      responseSubscription?.remove();
    };
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}