import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, Alert, RefreshControl, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useDownloadHistory, useDeleteHistoryItem } from '../hooks/useVideoQueries';
import { DownloadRecord } from '../context/DbContext';

export default function HistoryScreen() {
  const router = useRouter();
  const { data: history = [], isLoading, refetch, isRefetching } = useDownloadHistory();
  const deleteMutation = useDeleteHistoryItem();

  const handlePlay = async (item: DownloadRecord) => {
    try {
      // Check the file still exists on device
      const info = await FileSystem.getInfoAsync(item.localPath);
      if (!info.exists) {
        Alert.alert(
          'File Not Found',
          'This video file no longer exists on your device. It may have been cleared by the system. Please download it again.',
          [{ text: 'OK' }]
        );
        return;
      }

      // Open the file with the native system video player via sharing/open
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(item.localPath, {
          mimeType: 'video/mp4',
          UTI: 'public.movie', // iOS
          dialogTitle: item.title,
        });
      } else {
        Alert.alert('Playback', 'Sharing/playback is not available on this device.');
      }
    } catch (err: any) {
      Alert.alert('Playback Error', err.message || 'Could not open the video file.');
    }
  };

  const handleDelete = (record: DownloadRecord) => {
    Alert.alert(
      'Remove from Library',
      `Delete "${record.title}" from your history?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync(record.id);
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to remove entry.');
            }
          },
        },
      ]
    );
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes <= 0) return 'Unknown size';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
  };

  const renderItem = ({ item }: { item: DownloadRecord }) => (
    <View className="bg-slate-900 border border-slate-800 p-4 rounded-3xl mb-3">
      {/* Thumbnail + Info Row */}
      <View className="flex-row items-center mb-3">
        <Image
          source={{ uri: item.thumbnail || 'https://placeholder.com' }}
          className="w-16 h-16 rounded-2xl bg-slate-950 mr-3"
          resizeMode="cover"
        />
        <View className="flex-1">
          <Text className="text-white font-bold text-sm mb-1" numberOfLines={2}>
            {item.title}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-indigo-400 text-xs font-semibold">{item.resolution}</Text>
            <Text className="text-slate-500 text-xs">•</Text>
            <Text className="text-slate-400 text-xs">{formatFileSize(item.fileSize)}</Text>
          </View>
          <Text className="text-slate-500 text-[10px] mt-0.5">
            {item.downloadedAt ? new Date(item.downloadedAt).toLocaleDateString() : 'Recently'}
          </Text>
        </View>
      </View>

      {/* Action Buttons Row */}
      <View className="flex-row gap-2">
        <TouchableOpacity
          onPress={() => handlePlay(item)}
          className="flex-1 bg-indigo-600 active:bg-indigo-700 py-2.5 rounded-xl items-center"
        >
          <Text className="text-white text-xs font-bold">▶ Play / Share</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleDelete(item)}
          className="bg-rose-950/60 border border-rose-900/80 px-4 py-2.5 rounded-xl items-center"
        >
          <Text className="text-rose-400 text-xs font-bold">Remove</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-slate-950 px-4 pt-4">
      {/* HEADER */}
      <View className="flex-row items-center justify-between mb-6">
        <TouchableOpacity
          onPress={() => router.back()}
          className="bg-slate-900 border border-slate-800 px-3 py-2 rounded-full flex-row items-center"
        >
          <Text className="text-indigo-400 text-xs font-bold">← Back</Text>
        </TouchableOpacity>
        <View className="items-center">
          <Text className="text-lg font-black text-white">Media Library</Text>
          <Text className="text-[10px] text-slate-400">{history.length} saved downloads</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      {/* DOWNLOADS LIST */}
      <FlatList
        data={history}
        keyExtractor={(item) => item.id.toString()}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor="#6366f1"
            colors={['#6366f1']}
          />
        }
        ListEmptyComponent={
          !isLoading ? (
            <View className="items-center justify-center py-20">
              <Text className="text-slate-400 font-bold text-base mb-1">No Downloads Yet</Text>
              <Text className="text-slate-600 text-xs text-center px-8">
                Videos you download using Server Boost or Phone Direct mode will be cataloged here.
              </Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
