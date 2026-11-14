import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { DownloadItem } from '../db/database';
import { useDownloads } from '../hooks/useDownloads';
import {
  pauseDownload,
  resumeDownload,
  retryDownload,
  saveItemToGallery,
  removeDownload,
} from '../services/downloadManager';

export function HistoryScreen() {
  const { downloads, loading } = useDownloads();
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [savingId, setSavingId] = useState<string | null>(null);

  const filteredDownloads = downloads.filter((item) => {
    if (filter === 'active') return item.status !== 'completed';
    if (filter === 'completed') return item.status === 'completed';
    return true;
  });

  const handleSaveToGallery = async (item: DownloadItem) => {
    setSavingId(item.id);
    try {
      await saveItemToGallery(item);
      Alert.alert('Saved', `"${item.title}" has been saved to your device gallery.`);
    } catch (err: any) {
      Alert.alert('Save Failed', err?.message || 'Could not save to gallery.');
    } finally {
      setSavingId(null);
    }
  };

  const confirmDelete = (item: DownloadItem) => {
    Alert.alert('Delete Download', `Remove "${item.title}" from Rooster?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => removeDownload(item),
      },
    ]);
  };

  const renderItem = ({ item }: { item: DownloadItem }) => {
    const percent = Math.round((item.progress || 0) * 100);
    const modeLabel =
      item.mode === 'auto'
        ? `${item.quality}p • Video+Audio`
        : item.mode === 'mute'
        ? `${item.quality}p • Video Only`
        : 'MP3 • Audio Only';

    return (
      <View className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 mb-3">
        {/* Title & Status Badge */}
        <View className="flex-row justify-between items-start mb-1.5">
          <Text
            numberOfLines={2}
            className="text-white font-bold text-base flex-1 pr-3"
          >
            {item.title}
          </Text>
          <StatusBadge status={item.status} />
        </View>

        {/* Format Metadata */}
        <Text className="text-zinc-400 text-xs mb-3">{modeLabel}</Text>

        {/* Error Message if Failed */}
        {item.status === 'failed' && item.error_message && (
          <Text className="text-red-400 text-xs bg-red-950/50 border border-red-900/50 rounded-lg p-2 mb-3">
            {item.error_message}
          </Text>
        )}

        {/* Progress Bar for Downloading / Paused */}
        {(item.status === 'downloading' || item.status === 'paused' || item.status === 'queued') && (
          <View className="mb-3">
            <View className="flex-row justify-between mb-1">
              <Text className="text-zinc-400 text-xs">
                {item.status === 'queued' ? 'Resolving stream...' : 'Progress'}
              </Text>
              <Text className="text-zinc-200 text-xs font-bold">{percent}%</Text>
            </View>
            <View className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <View
                style={{ width: `${percent}%` }}
                className={`h-full rounded-full ${
                  item.status === 'paused' ? 'bg-amber-500' : 'bg-red-500'
                }`}
              />
            </View>
          </View>
        )}

        {/* Action Buttons Row */}
        <View className="flex-row items-center justify-end gap-2 pt-1">
          {item.status === 'downloading' && (
            <TouchableOpacity
              onPress={() => pauseDownload(item.id)}
              className="bg-amber-500/20 border border-amber-500/40 px-3.5 py-2 rounded-xl"
            >
              <Text className="text-amber-300 text-xs font-bold">Pause</Text>
            </TouchableOpacity>
          )}

          {item.status === 'paused' && (
            <TouchableOpacity
              onPress={() => resumeDownload(item)}
              className="bg-emerald-500/20 border border-emerald-500/40 px-3.5 py-2 rounded-xl"
            >
              <Text className="text-emerald-300 text-xs font-bold">Resume</Text>
            </TouchableOpacity>
          )}

          {item.status === 'failed' && (
            <TouchableOpacity
              onPress={() => retryDownload(item)}
              className="bg-sky-500/20 border border-sky-500/40 px-3.5 py-2 rounded-xl"
            >
              <Text className="text-sky-300 text-xs font-bold">Retry</Text>
            </TouchableOpacity>
          )}

          {item.status === 'completed' && (
            <TouchableOpacity
              disabled={item.saved_to_gallery === 1 || savingId === item.id}
              onPress={() => handleSaveToGallery(item)}
              className={`px-3.5 py-2 rounded-xl border ${
                item.saved_to_gallery === 1
                  ? 'bg-emerald-950/60 border-emerald-700/40'
                  : 'bg-red-600 border-red-500'
              }`}
            >
              {savingId === item.id ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text
                  className={`text-xs font-bold ${
                    item.saved_to_gallery === 1 ? 'text-emerald-400' : 'text-white'
                  }`}
                >
                  {item.saved_to_gallery === 1 ? 'Saved to Gallery ✓' : 'Save to Gallery'}
                </Text>
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={() => confirmDelete(item)}
            className="bg-zinc-800 px-3 py-2 rounded-xl"
          >
            <Text className="text-zinc-400 text-xs font-semibold">Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-zinc-950 px-5 pt-6">
      <Text className="text-2xl font-extrabold text-white mb-4">
        Library & Queue
      </Text>

      {/* Filter Tabs */}
      <View className="flex-row gap-2 mb-4">
        {(['all', 'active', 'completed'] as const).map((tab) => (
          <TouchableOpacity
            key={tab}
            onPress={() => setFilter(tab)}
            className={`px-4 py-2 rounded-full border ${
              filter === tab
                ? 'bg-white border-white'
                : 'bg-zinc-900 border-zinc-800'
            }`}
          >
            <Text
              className={`text-xs font-bold capitalize ${
                filter === tab ? 'text-zinc-950' : 'text-zinc-400'
              }`}
            >
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color="#ef4444" className="mt-10" />
      ) : (
        <FlatList
          data={filteredDownloads}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={
            <View className="items-center justify-center py-16">
              <Text className="text-zinc-500 text-sm">
                No downloads in this list yet.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function StatusBadge({ status }: { status: DownloadItem['status'] }) {
  const styles: Record<DownloadItem['status'], string> = {
    queued: 'bg-zinc-800 text-zinc-300',
    downloading: 'bg-red-500/20 text-red-400',
    paused: 'bg-amber-500/20 text-amber-300',
    completed: 'bg-emerald-500/20 text-emerald-400',
    failed: 'bg-rose-500/20 text-rose-400',
  };

  return (
    <View className={`px-2.5 py-1 rounded-md ${styles[status].split(' ')[0]}`}>
      <Text className={`text-[10px] font-extrabold uppercase ${styles[status].split(' ')[1]}`}>
        {status}
      </Text>
    </View>
  );
}
