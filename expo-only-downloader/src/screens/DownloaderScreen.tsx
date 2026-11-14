import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { DownloadMode } from '../db/database';
import { VideoQuality } from '../services/cobalt';
import { startNewDownload } from '../services/downloadManager';
import { useDownloads } from '../hooks/useDownloads';

const MODES: { label: string; value: DownloadMode }[] = [
  { label: 'Audio + Video', value: 'auto' },
  { label: 'Video Only', value: 'mute' },
  { label: 'Audio Only', value: 'audio' },
];

const RESOLUTIONS: { label: string; value: VideoQuality }[] = [
  { label: '1080p', value: '1080' },
  { label: '720p', value: '720' },
  { label: '480p', value: '480' },
  { label: '360p', value: '360' },
];

interface Props {
  onOpenHistory: () => void;
}

export function DownloaderScreen({ onOpenHistory }: Props) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<DownloadMode>('auto');
  const [quality, setQuality] = useState<VideoQuality>('1080');
  const [submitting, setSubmitting] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null);

  const { downloads } = useDownloads();
  const activeDownloads = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued'
  );

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setUrl(text.trim());
  };

  const handleStartDownload = async () => {
    if (!url.trim()) {
      Alert.alert('Missing Link', 'Please paste a video URL first.');
      return;
    }

    setSubmitting(true);
    try {
      startNewDownload(url.trim(), mode, quality).catch(() => {});
      setUrl('');
      setQueuedNotice('Added to background queue! Paste another link anytime.');
      setTimeout(() => setQueuedNotice(null), 3500);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView className="flex-1 bg-zinc-950 px-5 pt-6">
      {/* Header */}
      <View className="mb-5">
        <Text className="text-3xl font-extrabold text-white tracking-tight">
          Rooster
        </Text>
        <Text className="text-zinc-400 text-sm mt-1">
          Paste links to queue multiple background downloads.
        </Text>
      </View>

      {/* Live Background Queue Status Banner */}
      {activeDownloads.length > 0 && (
        <TouchableOpacity
          onPress={onOpenHistory}
          className="bg-zinc-900 border border-red-500/40 rounded-2xl p-3.5 mb-5 flex-row items-center justify-between"
        >
          <View className="flex-row items-center gap-2.5 flex-1">
            <ActivityIndicator size="small" color="#ef4444" />
            <Text numberOfLines={1} className="text-zinc-200 text-xs font-bold flex-1">
              {activeDownloads.length === 1
                ? `Downloading: ${activeDownloads.title}`
                : `${activeDownloads.length} videos downloading in background`}
            </Text>
          </View>
          <Text className="text-red-400 text-xs font-extrabold ml-2">View →</Text>
        </TouchableOpacity>
      )}

      {/* Confirmation Toast */}
      {queuedNotice && (
        <View className="bg-emerald-950/80 border border-emerald-700/50 rounded-xl px-4 py-2.5 mb-4">
          <Text className="text-emerald-300 text-xs font-semibold">{queuedNotice}</Text>
        </View>
      )}

      {/* URL Input Card */}
      <View className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 mb-6">
        <Text className="text-zinc-300 text-xs font-semibold uppercase tracking-wider mb-2">
          Media Link
        </Text>
        <View className="flex-row items-center bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2">
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://..."
            placeholderTextColor="#71717a"
            autoCapitalize="none"
            autoCorrect={false}
            className="flex-1 text-white text-base py-1.5"
          />
          {url.length > 0 ? (
            <TouchableOpacity
              onPress={() => setUrl('')}
              className="bg-zinc-800 px-3 py-1.5 rounded-lg ml-2"
            >
              <Text className="text-zinc-300 text-xs font-semibold">Clear</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handlePaste}
              className="bg-red-600/20 border border-red-500/40 px-3 py-1.5 rounded-lg ml-2"
            >
              <Text className="text-red-400 text-xs font-semibold">Paste</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Format Mode Filter */}
      <View className="mb-6">
        <Text className="text-zinc-300 text-xs font-semibold uppercase tracking-wider mb-2.5">
          Format Mode
        </Text>
        <View className="flex-row gap-2">
          {MODES.map((item) => {
            const active = mode === item.value;
            return (
              <TouchableOpacity
                key={item.value}
                onPress={() => setMode(item.value)}
                className={`flex-1 py-3 px-2 rounded-xl border items-center ${
                  active ? 'bg-red-600 border-red-500' : 'bg-zinc-900 border-zinc-800'
                }`}
              >
                <Text
                  className={`text-xs font-bold ${
                    active ? 'text-white' : 'text-zinc-400'
                  }`}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Resolution Filter */}
      <View className={`mb-8 ${mode === 'audio' ? 'opacity-40' : ''}`}>
        <View className="flex-row justify-between items-center mb-2.5">
          <Text className="text-zinc-300 text-xs font-semibold uppercase tracking-wider">
            Resolution
          </Text>
          {mode === 'audio' && (
            <Text className="text-zinc-500 text-xs">Not used for Audio Only</Text>
          )}
        </View>
        <View className="flex-row gap-2">
          {RESOLUTIONS.map((res) => {
            const active = quality === res.value;
            return (
              <TouchableOpacity
                key={res.value}
                disabled={mode === 'audio'}
                onPress={() => setQuality(res.value)}
                className={`flex-1 py-3 rounded-xl border items-center ${
                  active && mode !== 'audio'
                    ? 'bg-zinc-100 border-white'
                    : 'bg-zinc-900 border-zinc-800'
                }`}
              >
                <Text
                  className={`text-xs font-bold ${
                    active && mode !== 'audio' ? 'text-zinc-950' : 'text-zinc-400'
                  }`}
                >
                  {res.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Primary Download Button */}
      <TouchableOpacity
        onPress={handleStartDownload}
        disabled={submitting}
        className="bg-red-600 active:bg-red-700 py-4 rounded-2xl items-center shadow-lg"
      >
        {submitting ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text className="text-white font-extrabold text-base tracking-wide">
            Download in Background
          </Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}
