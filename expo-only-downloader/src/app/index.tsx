import React, { useState, useEffect } from 'react';
import { SafeAreaView, View, TouchableOpacity, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { DownloaderScreen } from '../screens/DownloaderScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { ensureNotificationPermissions } from '../services/downloadManager';
import { useDownloads } from '../hooks/useDownloads';

export default function App() {
  const [activeTab, setActiveTab] = useState<'download' | 'history'>('download');
  const { downloads } = useDownloads();

  const activeCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued'
  ).length;

  useEffect(() => {
    ensureNotificationPermissions();
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-zinc-950">
      <StatusBar style="light" />

      <View className="flex-1">
        {activeTab === 'download' ? (
          <DownloaderScreen onOpenHistory={() => setActiveTab('history')} />
        ) : (
          <HistoryScreen />
        )}
      </View>

      {/* Bottom Tab Bar */}
      <View className="flex-row bg-zinc-900 border-t border-zinc-800 px-6 py-3">
        <TouchableOpacity
          onPress={() => setActiveTab('download')}
          className="flex-1 items-center py-1"
        >
          <Text
            className={`text-sm font-bold ${
              activeTab === 'download' ? 'text-red-500' : 'text-zinc-400'
            }`}
          >
            Download
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setActiveTab('history')}
          className="flex-1 items-center py-1 flex-row justify-center gap-1.5"
        >
          <Text
            className={`text-sm font-bold ${
              activeTab === 'history' ? 'text-red-500' : 'text-zinc-400'
            }`}
          >
            History
          </Text>
          {activeCount > 0 && (
            <View className="bg-red-600 px-2 py-0.5 rounded-full">
              <Text className="text-white text-[10px] font-extrabold">
                {activeCount}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}