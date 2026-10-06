import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Image, ScrollView, ActivityIndicator, Alert, Switch, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { useRouter } from 'expo-router';
import { useFastApiMetadata, VideoFormat } from '../hooks/useFatapi';
import { useLogDownload } from '../hooks/useVideoQueries';
import { executeDownload as executeSingleThreadDownload } from '../utils/downloadEngine';
import { BACKEND_BASE_URL } from '../constants/config';

interface DownloadQueuedResponse {
  taskId: string;
}

interface DownloadStatusResponse {
  status: 'queued' | 'processing' | 'retrying' | 'success' | 'failure';
  fileName?: string;
  fileSize?: number;
  error?: string;
}

export default function HomeScreen() {
  const router = useRouter();
  const [inputUrl, setInputUrl] = useState('');
  const [searchUrl, setSearchUrl] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);

  // Download orchestration states
  const [isBoostMode, setIsBoostMode] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);

  const { data: videoInfo, isLoading, error } = useFastApiMetadata(searchUrl);
  const logDownloadMutation = useLogDownload();

  const handleSearch = () => {
    if (!inputUrl.trim().startsWith('http')) {
      Alert.alert('Invalid URL', 'Please paste a valid video link.');
      return;
    }
    setSelectedFormat(null);
    setSearchUrl(inputUrl.trim());
  };

  const requestGalleryPermission = async (): Promise<void> => {
    if (Platform.OS === 'web') return;

    const permission = await MediaLibrary.requestPermissionsAsync(false, ['video']);
    if (!permission.granted) {
      throw new Error('Gallery permission is required to save downloaded videos.');
    }
  };

  const saveToGallery = async (fileUri: string): Promise<string> => {
    if (Platform.OS === 'web') return fileUri;

    const album = await MediaLibrary.Album.get('MeloStream');
    const asset = await MediaLibrary.Asset.create(fileUri, album ?? undefined);
    if (!album) {
      await MediaLibrary.Album.create('MeloStream', [asset]);
    }

    const galleryUri = await asset.getUri();
    await FileSystem.deleteAsync(fileUri);
    return galleryUri;
  };

  const handleDownload = async () => {
    if (!videoInfo || !selectedFormat) {
      Alert.alert('Selection Required', 'Please select a video quality format resolution.');
      return;
    }

    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadSpeed(0);
      await requestGalleryPermission();
      const downloadStartTime = Date.now();

      const appStorageDirectory = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '';
      const localDirectory = `${appStorageDirectory}downloads/`;
      let finalLocalUri = '';

      // Ensure base storage directory path exists cleanly on hardware disk space
      const dirCheck = await FileSystem.getInfoAsync(localDirectory);
      if (!dirCheck.exists) {
        await FileSystem.makeDirectoryAsync(localDirectory, { intermediates: true });
      }

      if (isBoostMode) {
        // --- 🚀 MODE A: FASTAPI CELERY BACKGROUND DOWNLOAD ---
        const serverResponse = await fetch(`${BACKEND_BASE_URL}/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: videoInfo.sourceUrl,
            format_id: selectedFormat.formatId,
            resolution: selectedFormat.resolution,
          }),
        });

        if (!serverResponse.ok) {
          const errData = await serverResponse.json();
          throw new Error(errData.detail || 'Server-side chunk assembly acceleration failed.');
        }

        const { taskId } = await serverResponse.json() as DownloadQueuedResponse;
        if (!taskId) throw new Error('The server did not return a download task ID.');
        let fileName: string | undefined;

        while (!fileName) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
          const statusResponse = await fetch(
            `${BACKEND_BASE_URL}/download/${encodeURIComponent(taskId)}`
          );
          if (!statusResponse.ok) {
            const errData = await statusResponse.json();
            throw new Error(errData.detail || 'Could not read server download status.');
          }

          const taskStatus = await statusResponse.json() as DownloadStatusResponse;
          if (taskStatus.status === 'failure') {
            throw new Error(taskStatus.error || 'Server-side video processing failed.');
          }
          if (taskStatus.status === 'success') {
            if (!taskStatus.fileName) {
              throw new Error('Server reported success without returning a video file.');
            }
            fileName = taskStatus.fileName;
          }
        }

        const targetStreamUrl = `${BACKEND_BASE_URL}/stream/${fileName}`;
        const targetLocalPath = `${localDirectory}${fileName}`;

        const downloadTask = FileSystem.createDownloadResumable(
          targetStreamUrl,
          targetLocalPath,
          { headers: { 'Connection': 'keep-alive' } },
          (progress) => {
            const written = progress.totalBytesWritten;
            const expected = progress.totalBytesExpectedToWrite;
            const percent = expected > 0 ? (written / expected) * 100 : 0;
            const elapsed = (Date.now() - downloadStartTime) / 1000;
            const currentSpeed = elapsed > 0 ? (written / (1024 * 1024)) / elapsed : 0;

            setDownloadProgress(Math.min(percent, 100));
            setDownloadSpeed(currentSpeed);
          }
        );

        const result = await downloadTask.downloadAsync();
        if (!result?.uri) throw new Error('File delivery network stream aborted.');
        finalLocalUri = result.uri;

      } else {
        // --- 📱 MODE B: SINGLE-STREAM DIRECT PHONE DOWNLOAD ---
        const generatedFileName = `melo_${Date.now()}.${selectedFormat.extension}`;
        const resultUri = await executeSingleThreadDownload({
          videoUrl: selectedFormat.url,
          fileName: generatedFileName,
          onProgress: (progress) => {
            setDownloadProgress(progress.progressPercent);
            setDownloadSpeed(progress.downloadSpeedMBs);
          }
        });

        if (!resultUri) throw new Error('Local background file storage stream aborted.');
        finalLocalUri = resultUri;
      }

      // Save to device gallery/My Files so it's accessible outside the app
      const localFileInfo = await FileSystem.getInfoAsync(finalLocalUri);
      const downloadedFileSize =
        localFileInfo.exists && typeof localFileInfo.size === 'number'
          ? localFileInfo.size
          : selectedFormat.fileSizeEstimate ?? 0;
      finalLocalUri = await saveToGallery(finalLocalUri);

      // Record in local SQLite history database
      await logDownloadMutation.mutateAsync({
        title: videoInfo.title,
        url: videoInfo.sourceUrl,
        localPath: finalLocalUri,
        fileSize: downloadedFileSize,
        resolution: selectedFormat.resolution,
        thumbnail: videoInfo.thumbnail,
      });

      Alert.alert(
        'Download Complete ✨',
        'Video saved to your device and MeloStream library!',
      );

    } catch (err: unknown) {
      console.error('[MeloStream Download Runtime Interrupted]:', err);
      Alert.alert(
        'Download Interrupted',
        err instanceof Error ? err.message : 'An unexpected file system error occurred.'
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-slate-950 px-4 pt-4">
      {/* APP TITLE ACTION HEADER */}
      <View className="flex-row justify-between items-center mb-6">
        <View>
          <Text className="text-2xl font-black text-white tracking-tight">MeloStream</Text>
          <Text className="text-xs text-slate-400">High-Velocity Media Library</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/history')}
          className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-full"
        >
          <Text className="text-indigo-400 text-xs font-bold">Library History</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} className="flex-1">
        {/* DUAL MODE ENGINE TOGGLE SWITCH */}
        <View className="bg-slate-900 border border-slate-800 p-4 rounded-3xl mb-4 flex-row justify-between items-center">
          <View className="flex-1 pr-4">
            <Text className="text-white font-bold text-sm mb-0.5">
              {isBoostMode ? '🚀 Server Boost Mode' : '📱 Phone Direct Mode'}
            </Text>
            <Text className="text-slate-400 text-xs">
              {isBoostMode
                ? 'Celery workers extract and merge your video before streaming it to your device.'
                : 'Phone downloads directly from CDN in a single background thread.'}
            </Text>
          </View>
          <Switch
            trackColor={{ false: '#334155', true: '#4f46e5' }}
            thumbColor={isBoostMode ? '#10b981' : '#94a3b8'}
            value={isBoostMode}
            onValueChange={setIsBoostMode}
            disabled={isDownloading}
          />
        </View>

        {/* DESTINATION SEARCH BAR INPUT CARD */}
        <View className="bg-slate-900 border border-slate-800 p-4 rounded-3xl mb-6">
          <Text className="text-slate-300 text-sm font-medium mb-2">Paste Video Destination Link</Text>
          <TextInput
            placeholder="TikTok, YouTube, Custom URL..."
            placeholderTextColor="#64748b"
            value={inputUrl}
            onChangeText={setInputUrl}
            className="bg-slate-950 border border-slate-800 text-white rounded-xl px-4 py-3 text-sm mb-3"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isDownloading}
          />
          <TouchableOpacity
            onPress={handleSearch}
            disabled={isLoading || isDownloading}
            className="bg-indigo-600 active:bg-indigo-700 disabled:opacity-50 py-3 rounded-xl flex-row justify-center items-center"
          >
            {isLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text className="text-white font-bold text-sm">Analyze Media Stream</Text>}
          </TouchableOpacity>
        </View>

        {/* ERROR STATUS CARD COMPONENT */}
        {error && (
          <View className="bg-rose-950/30 border border-rose-900 p-4 rounded-2xl mb-6">
            <Text className="text-rose-400 text-sm text-center font-medium">{error.message || 'Error communicating with analyzer.'}</Text>
          </View>
        )}

        {/* PROGRESS METRICS INFOCARD BAR PANEL */}
        {isDownloading && (
          <View className="bg-slate-900 border border-indigo-950 p-4 rounded-3xl mb-6">
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-white text-xs font-semibold">
                {isBoostMode ? 'Preparing server download...' : 'Downloading video...'}
              </Text>
              <Text className="text-indigo-400 text-xs font-bold">{downloadSpeed.toFixed(2)} MB/s</Text>
            </View>
            <View className="w-full h-2 bg-slate-950 rounded-full overflow-hidden mb-2">
              <View className="h-full bg-indigo-500 rounded-full" style={{ width: `${downloadProgress}%` }} />
            </View>
            <Text className="text-right text-slate-400 text-[10px]">{downloadProgress.toFixed(1)}% Completed</Text>
          </View>
        )}

        {/* DISPLAY COMPONENT PARSING INTERACTION METADATA */}
        {videoInfo && (
          <View className="bg-slate-900 border border-slate-800 rounded-3xl p-4 mb-6">
            <Image
              source={{ uri: videoInfo.thumbnail || 'https://placeholder.com' }}
              className="w-full h-48 rounded-2xl mb-4 bg-slate-950"
              resizeMode="cover"
            />
            <Text className="text-white font-bold text-base mb-1" numberOfLines={2}>{videoInfo.title}</Text>
            <Text className="text-slate-400 text-xs mb-4">By {videoInfo.uploader || 'Unknown Origin Creator'}</Text>

            {/* Quality / Format Selection List */}
            <Text className="text-slate-300 font-semibold text-xs mb-3">SELECT QUALITY / FORMAT</Text>
            <View className="gap-2 mb-4">
              {videoInfo.formats && videoInfo.formats.length > 0 ? (
                videoInfo.formats.map((fmt) => {
                  const isSelected = selectedFormat?.formatId === fmt.formatId;
                  const sizeMB = fmt.fileSizeEstimate ? (fmt.fileSizeEstimate / (1024 * 1024)).toFixed(1) : null;
                  return (
                    <TouchableOpacity
                      key={fmt.formatId}
                      onPress={() => setSelectedFormat(fmt)}
                      disabled={isDownloading}
                      className={`p-3 rounded-2xl border flex-row justify-between items-center ${
                        isSelected
                          ? 'bg-indigo-950/70 border-indigo-500'
                          : 'bg-slate-950/60 border-slate-800'
                      }`}
                    >
                      <View className="flex-1 mr-2">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-white font-bold text-xs">{fmt.resolution}</Text>
                          <Text className="text-slate-400 text-[10px] uppercase font-mono">{fmt.extension}</Text>
                          {fmt.hasAudio && !fmt.hasVideo && (
                            <Text className="text-emerald-400 text-[10px] bg-emerald-950 px-1.5 py-0.5 rounded">Audio Only</Text>
                          )}
                        </View>
                        <Text className="text-slate-500 text-[10px] mt-0.5">
                          {sizeMB ? `~${sizeMB} MB` : 'Dynamic Size'}
                        </Text>
                      </View>
                      <View
                        className={`w-5 h-5 rounded-full border items-center justify-center ${
                          isSelected ? 'border-indigo-400 bg-indigo-600' : 'border-slate-700'
                        }`}
                      >
                        {isSelected && <View className="w-2 h-2 rounded-full bg-white" />}
                      </View>
                    </TouchableOpacity>
                  );
                })
              ) : (
                <Text className="text-slate-500 text-xs">No explicit stream formats available.</Text>
              )}
            </View>

            {/* Trigger Download Button */}
            <TouchableOpacity
              onPress={handleDownload}
              disabled={!selectedFormat || isDownloading}
              className="bg-emerald-600 active:bg-emerald-700 disabled:opacity-40 py-3.5 rounded-2xl flex-row justify-center items-center shadow-lg"
            >
              {isDownloading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text className="text-white font-bold text-sm">
                  {selectedFormat ? `Download ${selectedFormat.resolution}` : 'Select a format to download'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}