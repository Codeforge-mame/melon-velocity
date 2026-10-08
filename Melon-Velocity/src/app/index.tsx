import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFastApiMetadata, VideoAppMode, VideoFormat } from '../hooks/useFatapi';
import {
  useActiveDownloadCount,
  useDownloadHistory,
  useLogDownload,
  useUpdateDownload,
} from '../hooks/useVideoQueries';
import { DownloadRecord } from '../context/DbContext';
import {
  clearDownloadCancellation,
  isDownloadCancelled,
  pauseActiveDownload,
  registerDownloadControls,
} from '../utils/downloadControls';
import { BACKEND_BASE_URL } from '../constants/config';
import { SocialAccount, SocialPlatform, useAuth } from '../context/AuthContext';

type AppMode = VideoAppMode;

interface DownloadQueuedResponse {
  taskId: string;
  cancellationToken: string;
}

interface DownloadStatusResponse {
  status: 'queued' | 'processing' | 'retrying' | 'success' | 'failure' | 'cancelled';
  fileName?: string;
  fileSize?: number;
  error?: string;
}

const MODES: { id: AppMode; title: string; subtitle: string; accent: string; background: string; surface: string; border: string }[] = [
  { id: 'default', title: 'Default', subtitle: 'Public links from any supported yt-dlp site', accent: '#818cf8', background: '#090d18', surface: '#111827', border: '#293449' },
  { id: 'youtube', title: 'YouTube', subtitle: 'YouTube session-based downloads', accent: '#fb4b4b', background: '#190b0d', surface: '#271214', border: '#512126' },
  { id: 'telegram', title: 'Telegram', subtitle: 'Telegram session-based downloads', accent: '#38bdf8', background: '#08172a', surface: '#10233c', border: '#21466c' },
  { id: 'tiktok', title: 'TikTok', subtitle: 'TikTok session-based downloads', accent: '#2dd4bf', background: '#071719', surface: '#102426', border: '#1d4a4b' },
];

const SOCIAL_PLATFORMS: SocialPlatform[] = ['youtube', 'telegram', 'tiktok'];
const platformLabel = (platform: SocialPlatform) =>
  platform.charAt(0).toUpperCase() + platform.slice(1);

function isSocialVideoUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
      ['t.me', 'telegram.me', 'telegram.org', 'telegra.ph'].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      );
  } catch {
    return false;
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    return body.detail || fallback;
  } catch {
    return fallback;
  }
}

export default function HomeScreen() {
  const routeParams = useLocalSearchParams<{ retryId?: string }>();
  const { data: history = [] } = useDownloadHistory();
  const retryId = routeParams.retryId;
  const initialRecord = retryId
    ? history.find((item) => item.id === Number(retryId))
    : undefined;
  const contentKey = retryId
    ? initialRecord
      ? `retry-${initialRecord.id}`
      : `retry-pending-${retryId}`
    : 'home';
  return <HomeScreenContent key={contentKey} initialRecord={initialRecord} />;
}

function HomeScreenContent({ initialRecord }: { initialRecord?: DownloadRecord }) {
  const router = useRouter();
  const { email, apiFetch, ensureAccessToken, login, signUp, logout, saveSocialCookies, deleteSocialAccount, getSocialAccounts } = useAuth();
  const [inputUrl, setInputUrl] = useState(initialRecord?.url ?? '');
  const [searchUrl, setSearchUrl] = useState(initialRecord?.url ?? '');
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);
  const [mode, setMode] = useState<AppMode>(initialRecord?.mode ?? 'default');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isSignup, setIsSignup] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cookiePlatform, setCookiePlatform] = useState<SocialPlatform>('youtube');
  const [cookieText, setCookieText] = useState('');
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);

  const [isBoostMode, setIsBoostMode] = useState(initialRecord?.serverBoost !== 0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const pausedDownloadIds = useRef(new Set<number>());
  const unregisterDownloadControls = useRef(new Map<number, () => void>());

  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];
  const { data: videoInfo, isLoading, error, refetch } = useFastApiMetadata(searchUrl, mode);
  const logDownloadMutation = useLogDownload();
  const updateDownloadMutation = useUpdateDownload();
  const { data: activeDownloadCount = 0 } = useActiveDownloadCount();

  const trackNativeDownload = (
    recordId: number,
    downloadTask: ReturnType<typeof FileSystem.createDownloadResumable>,
    destination: string,
  ) => {
    const unregisterPrevious = unregisterDownloadControls.current.get(recordId);
    unregisterPrevious?.();
    const controls = {
      pause: async () => {
        const snapshot = await downloadTask.pauseAsync();
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
        pausedDownloadIds.current.add(recordId);
        await updateDownloadMutation.mutateAsync({
          id: recordId,
          update: {
            status: 'paused',
            resumeSnapshot: JSON.stringify(safeSnapshot),
          },
        });
      },
      cancel: async () => {
        await downloadTask.cancelAsync();
        await FileSystem.deleteAsync(destination, { idempotent: true });
        await updateDownloadMutation.mutateAsync({
          id: recordId,
          update: { status: 'cancelled', resumeSnapshot: null, cancelToken: null },
        });
      },
    };
    unregisterDownloadControls.current.set(
      recordId,
      registerDownloadControls(recordId, controls),
    );
  };
  const untrackNativeDownload = (recordId: number) => {
    unregisterDownloadControls.current.get(recordId)?.();
    unregisterDownloadControls.current.delete(recordId);
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        for (const activeDownloadId of unregisterDownloadControls.current.keys()) {
          void pauseActiveDownload(activeDownloadId).catch((pauseError: unknown) => {
            console.error('[MeloStream automatic download pause failed]', pauseError);
          });
        }
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!email) return;
    let active = true;
    void getSocialAccounts()
      .then((accounts) => {
        if (active) setSocialAccounts(accounts);
      })
      .catch((err: unknown) => console.error('[MeloStream social account lookup failed]', err));
    return () => {
      active = false;
    };
  }, [email, getSocialAccounts]);

  const handleSearch = () => {
    if (!inputUrl.trim().startsWith('http')) {
      Alert.alert('Invalid URL', 'Please paste a valid video link.');
      return;
    }
    const targetUrl = inputUrl.trim();
    setSelectedFormat(null);
    if (targetUrl === searchUrl) {
      void refetch();
    } else {
      setSearchUrl(targetUrl);
    }
  };

  const requestGalleryPermission = async (): Promise<void> => {
    if (Platform.OS === 'web') return;
    const permission = await MediaLibrary.requestPermissionsAsync(false, ['video']);
    if (!permission.granted) {
      throw new Error('Gallery permission is required to save downloaded videos.');
    }
  };

  const saveToGallery = async (fileUri: string): Promise<{ uri: string; assetId: string | null }> => {
    if (Platform.OS === 'web') return { uri: fileUri, assetId: null };
    const album = await MediaLibrary.Album.get('MeloStream');
    const asset = await MediaLibrary.Asset.create(fileUri, album ?? undefined);
    if (!album) await MediaLibrary.Album.create('MeloStream', [asset]);
    const galleryUri = await asset.getUri();
    await FileSystem.deleteAsync(fileUri);
    return { uri: galleryUri, assetId: asset.id };
  };

  const handleDownload = async () => {
    if (!videoInfo || !selectedFormat) {
      Alert.alert('Selection Required', 'Please select a video quality format resolution.');
      return;
    }

    let downloadRecordId: number | null = null;
    let temporaryDownloadPath: string | null = null;
    let lastHistoryProgressUpdate = 0;
    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadSpeed(0);
      pausedDownloadIds.current.clear();
      await requestGalleryPermission();
      const downloadStartTime = Date.now();
      const appStorageDirectory = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '';
      const localDirectory = `${appStorageDirectory}downloads/`;
      const dirCheck = await FileSystem.getInfoAsync(localDirectory);
      if (!dirCheck.exists) {
        await FileSystem.makeDirectoryAsync(localDirectory, { intermediates: true });
      }

      const isSocialPlatform = isSocialVideoUrl(videoInfo.sourceUrl);
      const historyRecordId = await logDownloadMutation.mutateAsync({
        title: videoInfo.title,
        url: videoInfo.sourceUrl,
        localPath: '',
        fileSize: selectedFormat.fileSizeEstimate ?? 0,
        resolution: selectedFormat.resolution,
        thumbnail: videoInfo.thumbnail,
        mediaAssetId: null,
        cancelToken: null,
        resumeSnapshot: null,
        mode,
        formatId: selectedFormat.formatId,
        serverBoost: isBoostMode ? 1 : 0,
        status: isBoostMode ? 'queued' : 'downloading',
        progress: 0,
        taskId: null,
        error: null,
      });
      downloadRecordId = historyRecordId;
      router.push('/history');
      let finalLocalUri = '';
      const updateHistoryProgress = (progress: number) => {
        setDownloadProgress(progress);
        const now = Date.now();
        if (now - lastHistoryProgressUpdate < 1000 && progress < 100) return;
        lastHistoryProgressUpdate = now;
        void updateDownloadMutation.mutateAsync({
          id: historyRecordId,
          update: { progress: Math.min(progress, 100) },
        }).catch((updateError: unknown) => {
          console.error('[MeloStream download history update failed]', updateError);
        });
      };

      if (isBoostMode || isSocialPlatform) {
        const serverResponse = await apiFetch('/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: videoInfo.sourceUrl,
            format_id: selectedFormat.formatId,
            resolution: selectedFormat.resolution,
            mode,
          }),
        });
        if (!serverResponse.ok) {
          throw new Error(await responseError(serverResponse, 'Server-side download could not be started.'));
        }

        const { taskId, cancellationToken } = await serverResponse.json() as DownloadQueuedResponse;
        if (!taskId) throw new Error('The server did not return a download task ID.');
        await updateDownloadMutation.mutateAsync({
          id: downloadRecordId,
          update: { taskId, cancelToken: cancellationToken, status: 'queued' },
        });
        let fileName: string | undefined;

        while (!fileName) {
          if (isDownloadCancelled(historyRecordId)) {
            throw new Error('Download cancelled.');
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
          const statusResponse = await apiFetch(`/download/${encodeURIComponent(taskId)}`);
          if (!statusResponse.ok) {
            throw new Error(await responseError(statusResponse, 'Could not read server download status.'));
          }
          const taskStatus = await statusResponse.json() as DownloadStatusResponse;
          if (taskStatus.status === 'cancelled') {
            throw new Error('Download cancelled.');
          }
          if (taskStatus.status === 'failure') {
            throw new Error(taskStatus.error || 'Server-side video processing failed.');
          }
          const status = taskStatus.status === 'queued' ? 'queued' : 'processing';
          await updateDownloadMutation.mutateAsync({
            id: downloadRecordId,
            update: { status },
          });
          if (taskStatus.status === 'success') {
            if (!taskStatus.fileName) throw new Error('Server reported success without a video file.');
            fileName = taskStatus.fileName;
          }
        }

        const targetStreamUrl = `${BACKEND_BASE_URL}/stream/${encodeURIComponent(fileName)}`;
        const targetLocalPath = `${localDirectory}${fileName}`;
        temporaryDownloadPath = targetLocalPath;
        const streamToken = isSocialPlatform ? await ensureAccessToken() : null;
        if (isSocialPlatform && !streamToken) {
          throw new Error('Please log in to download this video');
        }
        await updateDownloadMutation.mutateAsync({
          id: downloadRecordId,
          update: { status: 'downloading', progress: 0 },
        });
        const downloadTask = FileSystem.createDownloadResumable(
          targetStreamUrl,
          targetLocalPath,
          {
            headers: {
              Connection: 'keep-alive',
              ...(streamToken ? { Authorization: `Bearer ${streamToken}` } : {}),
            },
          },
          (progress) => {
            const written = progress.totalBytesWritten;
            const expected = progress.totalBytesExpectedToWrite;
            const percent = expected > 0 ? (written / expected) * 100 : 0;
            const elapsed = (Date.now() - downloadStartTime) / 1000;
            updateHistoryProgress(percent);
            setDownloadSpeed(elapsed > 0 ? (written / (1024 * 1024)) / elapsed : 0);
          },
        );
        trackNativeDownload(historyRecordId, downloadTask, targetLocalPath);
        const result = await downloadTask.downloadAsync();
        untrackNativeDownload(historyRecordId);
        if (pausedDownloadIds.current.has(historyRecordId)) return;
        if (!result?.uri) throw new Error('File delivery network stream aborted.');
        finalLocalUri = result.uri;
      } else {
        await updateDownloadMutation.mutateAsync({
          id: downloadRecordId,
          update: { status: 'downloading', progress: 0 },
        });
        const targetLocalPath =
          `${localDirectory}melo_${Date.now()}.${selectedFormat.extension}`;
        temporaryDownloadPath = targetLocalPath;
        const downloadTask = FileSystem.createDownloadResumable(
          selectedFormat.url,
          targetLocalPath,
          {},
          (progress) => {
            const written = progress.totalBytesWritten;
            const expected = progress.totalBytesExpectedToWrite;
            const elapsed = (Date.now() - downloadStartTime) / 1000;
            updateHistoryProgress(expected > 0 ? (written / expected) * 100 : 0);
            setDownloadSpeed(elapsed > 0 ? (written / (1024 * 1024)) / elapsed : 0);
          },
        );
        trackNativeDownload(historyRecordId, downloadTask, targetLocalPath);
        const result = await downloadTask.downloadAsync();
        untrackNativeDownload(historyRecordId);
        if (pausedDownloadIds.current.has(historyRecordId)) return;
        if (!result?.uri) throw new Error('Local file download stream aborted.');
        finalLocalUri = result.uri;
      }

      const localFileInfo = await FileSystem.getInfoAsync(finalLocalUri);
      const downloadedFileSize =
        localFileInfo.exists && typeof localFileInfo.size === 'number'
          ? localFileInfo.size
          : selectedFormat.fileSizeEstimate ?? 0;
      const savedAsset = await saveToGallery(finalLocalUri);
      await updateDownloadMutation.mutateAsync({
        id: downloadRecordId,
        update: {
          localPath: savedAsset.uri,
          mediaAssetId: savedAsset.assetId,
          fileSize: downloadedFileSize,
          status: 'completed',
          progress: 100,
          resumeSnapshot: null,
          cancelToken: null,
          error: null,
        },
      });
      untrackNativeDownload(historyRecordId);
      clearDownloadCancellation(historyRecordId);
      temporaryDownloadPath = null;
    } catch (err: unknown) {
      console.error('[MeloStream Download Runtime Interrupted]:', err);
      const wasPaused =
        downloadRecordId !== null && pausedDownloadIds.current.has(downloadRecordId);
      const wasCancelled =
        downloadRecordId !== null && isDownloadCancelled(downloadRecordId);
      if (!wasPaused && !wasCancelled && temporaryDownloadPath) {
        try {
          await FileSystem.deleteAsync(temporaryDownloadPath, { idempotent: true });
        } catch (cleanupError: unknown) {
          console.error('[MeloStream failed to remove partial download]', cleanupError);
        }
      }
      if (downloadRecordId !== null && !wasPaused && !wasCancelled) {
        try {
          await updateDownloadMutation.mutateAsync({
            id: downloadRecordId,
            update: {
              status: 'failed',
              resumeSnapshot: null,
              cancelToken: null,
              error: err instanceof Error ? err.message : 'An unexpected download error occurred.',
            },
          });
        } catch (historyError: unknown) {
          console.error('[MeloStream failed to record download error]', historyError);
        }
      }
      if (!wasPaused && !wasCancelled) {
        Alert.alert(
          'Download Interrupted',
          err instanceof Error ? err.message : 'An unexpected file system error occurred.',
        );
      }
    } finally {
      if (downloadRecordId !== null) untrackNativeDownload(downloadRecordId);
      setIsDownloading(false);
    }
  };

  const handleAccountSubmit = async () => {
    try {
      if (isSignup) await signUp(accountEmail.trim(), password);
      else await login(accountEmail.trim(), password);
      setPassword('');
      Alert.alert(isSignup ? 'Account Created' : 'Signed In', 'Your MeloStream account is ready.');
    } catch (err: unknown) {
      Alert.alert('Account Error', err instanceof Error ? err.message : 'Could not sign in.');
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setSocialAccounts([]);
    } catch (err: unknown) {
      Alert.alert('Sign Out Error', err instanceof Error ? err.message : 'Could not sign out.');
    }
  };

  const handleSaveCookies = async () => {
    try {
      await saveSocialCookies(cookiePlatform, cookieText.trim());
      setCookieText('');
      setSocialAccounts(await getSocialAccounts());
      Alert.alert('Session Saved', `${platformLabel(cookiePlatform)} cookies were encrypted and saved.`);
    } catch (err: unknown) {
      Alert.alert('Could Not Save Session', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleRemoveCookies = async (platform: SocialPlatform) => {
    try {
      await deleteSocialAccount(platform);
      setSocialAccounts(await getSocialAccounts());
    } catch (err: unknown) {
      Alert.alert('Could Not Remove Session', err instanceof Error ? err.message : 'Try again.');
    }
  };

  return (
    <SafeAreaView className="flex-1 px-4 pt-4" style={{ backgroundColor: activeMode.background }}>
      <View className="flex-row justify-between items-center mb-6">
        <View>
          <Text className="text-2xl font-black text-white tracking-tight">MeloStream</Text>
          <Text style={{ color: activeMode.accent }} className="text-xs font-semibold">
            {activeMode.title} Mode · High-Velocity Media Library
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <TouchableOpacity
            onPress={() => router.push('/history')}
            className="px-3 py-2 rounded-full"
            style={{ backgroundColor: activeMode.surface, borderColor: activeMode.border, borderWidth: 1 }}
          >
            <View className="flex-row items-center gap-2">
              <Text style={{ color: activeMode.accent }} className="text-xs font-bold">History</Text>
              {activeDownloadCount > 0 && (
                <View className="min-w-5 h-5 px-1 rounded-full bg-red-600 items-center justify-center">
                  <Text className="text-white text-[10px] font-black">{activeDownloadCount}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Open sidebar settings"
            onPress={() => setSettingsOpen(true)}
            className="px-3 py-2 rounded-full"
            style={{ backgroundColor: activeMode.surface, borderColor: activeMode.border, borderWidth: 1 }}
          >
            <Text className="text-white text-base font-bold">☰</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} className="flex-1" contentContainerStyle={{ paddingBottom: 20 }}>
        <View className="p-4 rounded-3xl mb-6" style={{ backgroundColor: activeMode.surface, borderColor: activeMode.border, borderWidth: 1 }}>
          <Text className="text-slate-300 text-sm font-medium mb-2">Paste Video Destination Link</Text>
          <TextInput
            placeholder="YouTube, Telegram, TikTok, or public URL"
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
            className="disabled:opacity-50 py-3 rounded-xl flex-row justify-center items-center"
            style={{ backgroundColor: activeMode.accent }}
          >
            {isLoading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text className="text-slate-950 font-bold text-sm">Analyze Media Stream</Text>}
          </TouchableOpacity>
          {!email && (
            <Text className="text-slate-400 text-xs mt-3 text-center">
              Choose the matching platform mode and sign in before analyzing YouTube, Telegram, or TikTok links.
            </Text>
          )}
        </View>

        {error && (
          <View className="bg-rose-950/30 border border-rose-900 p-4 rounded-2xl mb-6">
            <Text className="text-rose-400 text-sm text-center font-medium">{error.message}</Text>
          </View>
        )}

        {isDownloading && (
          <View className="p-4 rounded-3xl mb-6" style={{ backgroundColor: activeMode.surface, borderColor: activeMode.border, borderWidth: 1 }}>
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-white text-xs font-semibold">
                {isBoostMode ? 'Preparing server download...' : 'Downloading video...'}
              </Text>
              <Text style={{ color: activeMode.accent }} className="text-xs font-bold">{downloadSpeed.toFixed(2)} MB/s</Text>
            </View>
            <View className="w-full h-2 bg-slate-950 rounded-full overflow-hidden mb-2">
              <View className="h-full rounded-full" style={{ width: `${downloadProgress}%`, backgroundColor: activeMode.accent }} />
            </View>
            <Text className="text-right text-slate-400 text-[10px]">{downloadProgress.toFixed(1)}% Completed</Text>
          </View>
        )}

        {videoInfo && (
          <View className="rounded-3xl p-4 mb-6" style={{ backgroundColor: activeMode.surface, borderColor: activeMode.border, borderWidth: 1 }}>
            <Image
              source={{ uri: videoInfo.thumbnail || 'https://placeholder.com' }}
              className="w-full h-48 rounded-2xl mb-4 bg-slate-950"
              resizeMode="cover"
            />
            <Text className="text-white font-bold text-base mb-1" numberOfLines={2}>{videoInfo.title}</Text>
            <Text className="text-slate-400 text-xs mb-4">By {videoInfo.uploader || 'Unknown Origin Creator'}</Text>
            <Text className="text-slate-300 font-semibold text-xs mb-3">SELECT QUALITY / FORMAT</Text>
            <View className="gap-2 mb-4">
              {videoInfo.formats?.length ? videoInfo.formats.map((format) => {
                const selected = selectedFormat?.formatId === format.formatId;
                const sizeMB = format.fileSizeEstimate
                  ? (format.fileSizeEstimate / (1024 * 1024)).toFixed(1)
                  : null;
                return (
                  <TouchableOpacity
                    key={format.formatId}
                    onPress={() => setSelectedFormat(format)}
                    disabled={isDownloading}
                    className="p-3 rounded-2xl border flex-row justify-between items-center"
                    style={{
                      backgroundColor: selected ? `${activeMode.accent}20` : '#080d17',
                      borderColor: selected ? activeMode.accent : activeMode.border,
                    }}
                  >
                    <View className="flex-1 mr-2">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-white font-bold text-xs">{format.resolution}</Text>
                        <Text className="text-slate-400 text-[10px] uppercase font-mono">{format.extension}</Text>
                        {format.hasAudio && !format.hasVideo && (
                          <Text className="text-emerald-400 text-[10px] bg-emerald-950 px-1.5 py-0.5 rounded">Audio Only</Text>
                        )}
                      </View>
                      <Text className="text-slate-500 text-[10px] mt-0.5">{sizeMB ? `~${sizeMB} MB` : 'Dynamic Size'}</Text>
                    </View>
                    <View className="w-5 h-5 rounded-full border items-center justify-center" style={{ borderColor: activeMode.accent }}>
                      {selected && <View className="w-2 h-2 rounded-full" style={{ backgroundColor: activeMode.accent }} />}
                    </View>
                  </TouchableOpacity>
                );
              }) : <Text className="text-slate-500 text-xs">No explicit stream formats available.</Text>}
            </View>
          </View>
        )}
      </ScrollView>

      {videoInfo && (
        <View
          className="border-t px-4 pt-3 pb-2"
          style={{
            backgroundColor: activeMode.background,
            borderColor: activeMode.border,
            zIndex: 100,
            elevation: 100,
          }}
        >
          <TouchableOpacity
            onPress={handleDownload}
            disabled={!selectedFormat || isDownloading}
            className="disabled:opacity-50 py-3.5 rounded-2xl items-center"
            style={{ backgroundColor: activeMode.accent }}
          >
            <Text className="text-slate-950 font-bold text-sm">
              {isDownloading
                ? 'Download in progress…'
                : isBoostMode
                  ? '🚀 Start Server Boost Download'
                  : '📱 Start Phone Direct Download'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal
        visible={settingsOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View className="flex-1 flex-row bg-black/60">
          <View className="w-[88%] max-w-[380px] bg-slate-950 px-5 pt-14 pb-8 border-r border-slate-800">
            <View className="flex-row items-center justify-between mb-5">
              <View>
                <Text className="text-white text-xl font-black">Sidebar Settings</Text>
                <Text className="text-slate-400 text-xs mt-1">Mode, download engine & account</Text>
              </View>
              <TouchableOpacity onPress={() => setSettingsOpen(false)} className="px-3 py-2 rounded-xl bg-slate-900">
                <Text className="text-white font-bold">✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <Text className="text-slate-300 font-bold text-xs mb-2">APP MODE</Text>
              <TouchableOpacity
                onPress={() => {
                  setSettingsOpen(false);
                  router.push('/social-guide');
                }}
                className="bg-indigo-950/50 border border-indigo-800 rounded-xl p-3 mb-4"
              >
                <Text className="text-indigo-300 font-bold text-xs">Social account setup guide →</Text>
                <Text className="text-slate-400 text-[10px] mt-1">How to connect YouTube, TikTok, and Telegram</Text>
              </TouchableOpacity>
              <View className="gap-2 mb-5">
                {MODES.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => setMode(item.id)}
                    className="p-3 rounded-2xl border"
                    style={{
                      backgroundColor: item.id === mode ? `${item.accent}1c` : '#111827',
                      borderColor: item.id === mode ? item.accent : '#263244',
                    }}
                  >
                    <Text style={{ color: item.accent }} className="font-bold text-sm">{item.title}</Text>
                    <Text className="text-slate-400 text-[11px] mt-1">{item.subtitle}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View className="bg-slate-900 border border-slate-800 p-4 rounded-2xl mb-5">
                <View className="flex-row justify-between items-center">
                  <View className="flex-1 pr-3">
                    <Text className="text-white font-bold text-sm">
                      {isBoostMode ? 'Server Boost' : 'Phone Direct'}
                    </Text>
                    <Text className="text-slate-400 text-xs mt-1">
                      {isBoostMode
                        ? 'Queue extraction and merge on the server.'
                        : 'Download through Expo; private-platform cookies remain on the server.'}
                    </Text>
                  </View>
                  <Switch
                    trackColor={{ false: '#334155', true: activeMode.accent }}
                    thumbColor={isBoostMode ? '#fff' : '#94a3b8'}
                    value={isBoostMode}
                    onValueChange={setIsBoostMode}
                    disabled={isDownloading}
                  />
                </View>
              </View>

              <Text className="text-slate-300 font-bold text-xs mb-2">ACCOUNT</Text>
              {email ? (
                <View className="bg-slate-900 border border-slate-800 p-4 rounded-2xl mb-5">
                  <Text className="text-slate-400 text-xs">Signed in as</Text>
                  <Text className="text-white font-bold mt-1 mb-3">{email}</Text>
                  <TouchableOpacity onPress={handleLogout} className="bg-rose-950 border border-rose-900 rounded-xl py-2.5 items-center">
                    <Text className="text-rose-300 text-xs font-bold">Sign Out</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View className="bg-slate-900 border border-slate-800 p-4 rounded-2xl mb-5">
                  <View className="flex-row gap-2 mb-3">
                    <TouchableOpacity onPress={() => setIsSignup(false)} className={`flex-1 py-2 rounded-lg ${!isSignup ? 'bg-indigo-600' : 'bg-slate-800'}`}>
                      <Text className="text-white text-center text-xs font-bold">Log In</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setIsSignup(true)} className={`flex-1 py-2 rounded-lg ${isSignup ? 'bg-indigo-600' : 'bg-slate-800'}`}>
                      <Text className="text-white text-center text-xs font-bold">Sign Up</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    value={accountEmail}
                    onChangeText={setAccountEmail}
                    placeholder="Email"
                    placeholderTextColor="#64748b"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    className="bg-slate-950 border border-slate-800 text-white rounded-xl px-3 py-3 text-sm mb-2"
                  />
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder={isSignup ? 'Password (10+ characters)' : 'Password'}
                    placeholderTextColor="#64748b"
                    secureTextEntry
                    className="bg-slate-950 border border-slate-800 text-white rounded-xl px-3 py-3 text-sm mb-3"
                  />
                  <TouchableOpacity onPress={handleAccountSubmit} className="rounded-xl py-3 items-center" style={{ backgroundColor: activeMode.accent }}>
                    <Text className="text-slate-950 font-bold text-sm">{isSignup ? 'Create Account' : 'Log In'}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {email && (
                <>
                  <Text className="text-slate-300 font-bold text-xs mb-1">SOCIAL SESSION COOKIES</Text>
                  <Text className="text-slate-500 text-[11px] mb-3">
                    Paste Netscape-format cookies exported from your own account. They are encrypted before storage.
                  </Text>
                  {SOCIAL_PLATFORMS.map((platform) => {
                    const saved = socialAccounts.some((account) => account.platform === platform);
                    return (
                      <View key={platform} className="bg-slate-900 border border-slate-800 p-3 rounded-xl mb-2 flex-row justify-between items-center">
                        <View>
                          <Text className="text-white font-bold text-xs">{platformLabel(platform)}</Text>
                          <Text className={`text-[10px] mt-1 ${saved ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {saved ? 'Session saved' : 'No session saved'}
                          </Text>
                        </View>
                        {saved && (
                          <TouchableOpacity onPress={() => handleRemoveCookies(platform)} className="px-2 py-1 rounded-lg bg-rose-950">
                            <Text className="text-rose-300 text-[10px] font-bold">Remove</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}
                  <View className="flex-row gap-2 my-2">
                    {SOCIAL_PLATFORMS.map((platform) => (
                      <TouchableOpacity
                        key={platform}
                        onPress={() => setCookiePlatform(platform)}
                        className={`flex-1 rounded-lg py-2 ${cookiePlatform === platform ? 'bg-indigo-600' : 'bg-slate-800'}`}
                      >
                        <Text className="text-white text-[10px] text-center font-bold">{platformLabel(platform)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    value={cookieText}
                    onChangeText={setCookieText}
                    placeholder="# Netscape HTTP Cookie File&#10;.youtube.com TRUE / TRUE 0 SID ..."
                    placeholderTextColor="#64748b"
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    textAlignVertical="top"
                    className="bg-slate-950 border border-slate-800 text-white rounded-xl px-3 py-3 text-xs h-32 mb-2"
                  />
                  <TouchableOpacity onPress={handleSaveCookies} className="bg-slate-800 rounded-xl py-3 items-center mb-5">
                    <Text className="text-white font-bold text-xs">Encrypt & Save {platformLabel(cookiePlatform)} Session</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>
          <TouchableOpacity
            accessibilityLabel="Close settings"
            onPress={() => setSettingsOpen(false)}
            className="flex-1"
          />
        </View>
      </Modal>
    </SafeAreaView>
  );
}
