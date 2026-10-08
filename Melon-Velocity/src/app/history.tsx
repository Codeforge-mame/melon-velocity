import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, Alert, RefreshControl, ActivityIndicator, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import type { DownloadPauseState } from 'expo-file-system/legacy';
import { useDownloadHistory, useDeleteHistoryItem, useUpdateDownload } from '../hooks/useVideoQueries';
import { DownloadRecord } from '../context/DbContext';
import { useAuth } from '../context/AuthContext';
import {
  cancelActiveDownload,
  clearDownloadCancellation,
  isDownloadCancelled,
  markDownloadCancelled,
  pauseActiveDownload,
  registerDownloadControls,
} from '../utils/downloadControls';

export default function HistoryScreen() {
  const router = useRouter();
  const { apiFetch, ensureAccessToken } = useAuth();
  const { data: history = [], isLoading, refetch, isRefetching } = useDownloadHistory();
  const deleteMutation = useDeleteHistoryItem();
  const updateMutation = useUpdateDownload();
  const lastProgressWrite = React.useRef(0);

  const readPauseState = (snapshot: string): DownloadPauseState => {
    const parsed: unknown = JSON.parse(snapshot);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('url' in parsed) ||
      typeof parsed.url !== 'string' ||
      !('fileUri' in parsed) ||
      typeof parsed.fileUri !== 'string' ||
      !('options' in parsed) ||
      typeof parsed.options !== 'object' ||
      parsed.options === null
    ) {
      throw new Error('This download cannot be resumed because its saved state is invalid.');
    }
    return parsed as DownloadPauseState;
  };

  const persistPauseState = async (recordId: number, snapshot: DownloadPauseState) => {
    const safeSnapshot = {
      ...snapshot,
      options: {
        ...snapshot.options,
        headers: Object.fromEntries(
          Object.entries(snapshot.options.headers ?? {}).filter(
            ([name]) => name.toLowerCase() !== 'authorization',
          ),
        ),
      },
    };
    await updateMutation.mutateAsync({
      id: recordId,
      update: { status: 'paused', resumeSnapshot: JSON.stringify(safeSnapshot) },
    });
  };

  const finishDownload = async (item: DownloadRecord, fileUri: string) => {
    const info = await FileSystem.getInfoAsync(fileUri);
    const fileSize = info.exists && 'size' in info ? info.size : item.fileSize;
    let localPath = fileUri;
    let mediaAssetId: string | null = null;
    if (Platform.OS !== 'web') {
      const permission = await MediaLibrary.requestPermissionsAsync(false, ['video']);
      if (!permission.granted) throw new Error('Gallery permission is required to save the video.');
      const album = await MediaLibrary.Album.get('MeloStream');
      const asset = await MediaLibrary.Asset.create(fileUri, album ?? undefined);
      if (!album) await MediaLibrary.Album.create('MeloStream', [asset]);
      localPath = await asset.getUri();
      mediaAssetId = asset.id;
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
    }
    await updateMutation.mutateAsync({
      id: item.id,
      update: {
        localPath,
        mediaAssetId,
        fileSize,
        status: 'completed',
        progress: 100,
        resumeSnapshot: null,
        cancelToken: null,
        error: null,
      },
    });
  };

  const resumeDownload = async (item: DownloadRecord) => {
    if (!item.resumeSnapshot) {
      Alert.alert('Cannot Resume', 'This download has no resumable transfer state.');
      return;
    }
    let unregister: (() => void) | undefined;
    let resumeFileUri: string | null = null;
    try {
      const snapshot = readPauseState(item.resumeSnapshot);
      resumeFileUri = snapshot.fileUri;
      const token = item.mode === 'default' ? null : await ensureAccessToken();
      if (item.mode !== 'default' && !token) {
        throw new Error('Please sign in again before resuming this download.');
      }
      const downloadTask = FileSystem.createDownloadResumable(
        snapshot.url,
        snapshot.fileUri,
        {
          ...snapshot.options,
          headers: {
            ...snapshot.options.headers,
            ...(token ? { Authorization: ['Bearer', token].join(' ') } : {}),
          },
        },
        (progress) => {
          const now = Date.now();
          if (progress.totalBytesExpectedToWrite > 0 && now - lastProgressWrite.current >= 1000) {
            lastProgressWrite.current = now;
            void updateMutation.mutateAsync({
              id: item.id,
              update: {
                progress: Math.min(
                  100,
                  (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100,
                ),
              },
            }).catch((error: unknown) => console.error('[MeloStream resume progress update failed]', error));
          }
        },
        snapshot.resumeData,
      );
      unregister = registerDownloadControls(item.id, {
        pause: async () => {
          const nextSnapshot = await downloadTask.pauseAsync();
          await persistPauseState(item.id, nextSnapshot);
        },
        cancel: async () => {
          await downloadTask.cancelAsync();
          await FileSystem.deleteAsync(snapshot.fileUri, { idempotent: true });
          await updateMutation.mutateAsync({
            id: item.id,
            update: { status: 'cancelled', resumeSnapshot: null, cancelToken: null },
          });
        },
      });
      await updateMutation.mutateAsync({
        id: item.id,
        update: { status: 'downloading', error: null },
      });
      const result = await downloadTask.resumeAsync();
      unregister();
      unregister = undefined;
      if (!result?.uri) return;
      await finishDownload(item, result.uri);
      clearDownloadCancellation(item.id);
    } catch (error: unknown) {
      unregister?.();
      if (isDownloadCancelled(item.id)) {
        clearDownloadCancellation(item.id);
        return;
      }
      if (resumeFileUri) {
        try {
          await FileSystem.deleteAsync(resumeFileUri, { idempotent: true });
        } catch (cleanupError: unknown) {
          console.error('[MeloStream failed to remove partial resumed download]', cleanupError);
        }
      }
      await updateMutation.mutateAsync({
        id: item.id,
        update: {
          status: 'failed',
          resumeSnapshot: null,
          cancelToken: null,
          error: error instanceof Error ? error.message : 'Could not resume this download.',
        },
      });
      Alert.alert(
        'Resume Failed',
        error instanceof Error ? error.message : 'Could not resume this download.',
      );
    }
  };

  const cancelDownload = async (item: DownloadRecord) => {
    try {
      const wasActive = await cancelActiveDownload(item.id);
      if (!wasActive && item.taskId && item.cancelToken && item.status !== 'downloading') {
        const response = await apiFetch(
          `/download/${encodeURIComponent(item.taskId)}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cancellationToken: item.cancelToken }),
          },
        );
        if (!response.ok && response.status !== 409) {
          const result = await response.json() as { detail?: string };
          throw new Error(result.detail || 'Could not cancel the server download.');
        }
        markDownloadCancelled(item.id);
      }
      if (!wasActive) {
        const snapshot = item.resumeSnapshot ? readPauseState(item.resumeSnapshot) : null;
        if (snapshot) await FileSystem.deleteAsync(snapshot.fileUri, { idempotent: true });
        await updateMutation.mutateAsync({
          id: item.id,
          update: { status: 'cancelled', resumeSnapshot: null, cancelToken: null },
        });
      }
    } catch (error: unknown) {
      Alert.alert(
        'Cancel Failed',
        error instanceof Error ? error.message : 'Could not cancel this download.',
      );
    }
  };

  const deleteDownloadedFile = async (item: DownloadRecord) => {
    if (item.resumeSnapshot) {
      const snapshot = readPauseState(item.resumeSnapshot);
      await FileSystem.deleteAsync(snapshot.fileUri, { idempotent: true });
    }
    if (!item.localPath) return;
    if (Platform.OS === 'web') {
      await FileSystem.deleteAsync(item.localPath, { idempotent: true });
      return;
    }

    if (item.mediaAssetId) {
      await new MediaLibrary.Asset(item.mediaAssetId).delete();
      return;
    }

    const album = await MediaLibrary.Album.get('MeloStream');
    if (!album) throw new Error('Could not locate the MeloStream album to remove this video.');

    const assets = await album.getAssets();
    const matchingAsset = await Promise.all(
      assets.map(async (asset) => ({
        asset,
        uri: await asset.getUri(),
      })),
    ).then((assetUris) =>
      assetUris.find(({ asset, uri }) => uri === item.localPath || asset.id === item.localPath),
    );
    if (!matchingAsset) {
      throw new Error('Could not find this video in the media library; its history entry was kept.');
    }
    await matchingAsset.asset.delete();
  };

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
              await deleteDownloadedFile(record);
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

  const renderItem = ({ item }: { item: DownloadRecord }) => {
    const isActive = ['queued', 'processing', 'downloading'].includes(item.status);
    const statusLabel = {
      queued: 'Queued',
      processing: 'Processing on server',
      downloading: 'Saving to device',
      paused: 'Paused',
      completed: 'Saved',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }[item.status];

    return (
      <View className="bg-slate-900 border border-slate-800 p-4 rounded-3xl mb-3">
        <View className="flex-row items-center mb-3">
          <Image
            source={item.thumbnail ? { uri: item.thumbnail } : undefined}
            className="w-16 h-16 rounded-2xl bg-slate-950 mr-3"
            resizeMode="cover"
          />
          <View className="flex-1">
            <Text className="text-white font-bold text-sm mb-1" numberOfLines={2}>
              {item.title}
            </Text>
            <Text className={`text-[10px] font-bold mb-1 ${item.status === 'failed' ? 'text-rose-400' : item.status === 'completed' ? 'text-emerald-400' : 'text-indigo-300'}`}>
              {statusLabel}
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

        {isActive && (
          <View className="mb-3">
            {(item.status === 'queued' || item.status === 'processing') && (
              <View className="flex-row items-center mb-2">
                <ActivityIndicator size="small" color="#818cf8" />
                <Text className="text-slate-300 text-[10px] ml-2">{statusLabel}</Text>
              </View>
            )}
            <View className="w-full h-2 bg-slate-950 rounded-full overflow-hidden mb-1.5">
              <View
                className="h-full rounded-full bg-indigo-500"
                style={{ width: `${Math.max(0, Math.min(item.progress, 100))}%` }}
              />
            </View>
            <Text className="text-right text-slate-400 text-[10px]">
              {item.status === 'queued' || item.status === 'processing'
                ? 'Your video is being prepared'
                : `${Math.round(item.progress)}%`}
            </Text>
          </View>
        )}

        {item.status === 'failed' && item.error && (
          <Text className="text-rose-300 text-xs mb-3">{item.error}</Text>
        )}

        <View className="flex-row gap-2">
          {item.status === 'downloading' && (
            <TouchableOpacity
              onPress={() => {
                void pauseActiveDownload(item.id).catch((error: unknown) => {
                  Alert.alert(
                    'Pause Failed',
                    error instanceof Error ? error.message : 'Could not pause this download.',
                  );
                });
              }}
              className="flex-1 bg-amber-950/60 border border-amber-900/80 px-4 py-2.5 rounded-xl items-center"
            >
              <Text className="text-amber-300 text-xs font-bold">Pause</Text>
            </TouchableOpacity>
          )}
          {item.status === 'paused' && item.resumeSnapshot && (
            <TouchableOpacity
              onPress={() => void resumeDownload(item)}
              className="flex-1 bg-indigo-600 active:bg-indigo-700 py-2.5 rounded-xl items-center"
            >
              <Text className="text-white text-xs font-bold">Resume</Text>
            </TouchableOpacity>
          )}
          {isActive && (
            <TouchableOpacity
              onPress={() => void cancelDownload(item)}
              className="flex-1 bg-rose-950/60 border border-rose-900/80 px-4 py-2.5 rounded-xl items-center"
            >
              <Text className="text-rose-400 text-xs font-bold">Cancel</Text>
            </TouchableOpacity>
          )}
          {item.status === 'completed' && (
            <TouchableOpacity
              onPress={() => handlePlay(item)}
              className="flex-1 bg-indigo-600 active:bg-indigo-700 py-2.5 rounded-xl items-center"
            >
              <Text className="text-white text-xs font-bold">▶ Play / Share</Text>
            </TouchableOpacity>
          )}
          {item.status === 'failed' && (
            <TouchableOpacity
              onPress={() =>
                router.push({
                  pathname: '/',
                  params: { retryId: item.id.toString() },
                })
              }
              className="flex-1 bg-indigo-600 active:bg-indigo-700 py-2.5 rounded-xl items-center"
            >
              <Text className="text-white text-xs font-bold">Retry</Text>
            </TouchableOpacity>
          )}
          {!isActive && (
            <TouchableOpacity
              onPress={() => handleDelete(item)}
              className="flex-1 bg-rose-950/60 border border-rose-900/80 px-4 py-2.5 rounded-xl items-center"
            >
              <Text className="text-rose-400 text-xs font-bold">Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

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
          <Text className="text-[10px] text-slate-400">
            {history.filter((item) => item.status === 'completed').length} saved · {history.filter((item) => ['queued', 'processing', 'downloading'].includes(item.status)).length} active
          </Text>
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
