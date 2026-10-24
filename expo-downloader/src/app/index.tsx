import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { resolveVideo } from "../app/api/videos";
import type { VideoFormat } from "../features/downloads/types";
import { startDownload } from "@/features/downloads/downloadManager";
import { useRouter } from "expo-router";
import { Sidebar } from "@/components/Sidebar";

function formatBytes(bytes: number | null) {
  if (bytes == null) return "Size unknown";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();

  const resolver = useMutation({
    mutationFn: (url: string) => resolveVideo(url),
    onSuccess: () => setSelectedFormat(null),
  });

  const submit = () => {
    const value = url.trim();

    if (!/^https?:\/\/\S+$/i.test(value)) {
      Alert.alert("Invalid URL", "Paste a valid video URL beginning with http:// or https://.");
      return;
    }

    resolver.mutate(value);
  };

  const video = resolver.data;

  // Group formats by category
  const groupedFormats = video ? {
    video: video.formats.filter(f => f.category === 'video'),
    'video-only': video.formats.filter(f => f.category === 'video-only'),
    'audio-only': video.formats.filter(f => f.category === 'audio-only'),
  } : { video: [], 'video-only': [], 'audio-only': [] };

  const categoryTitles: Record<string, string> = {
    video: 'Video + Audio (Recommended)',
    'video-only': 'Video Only',
    'audio-only': 'Audio Only',
  };

  const categoryDescriptions: Record<string, string> = {
    video: 'Complete video files with both video and audio',
    'video-only': 'Video without audio (may require separate audio download)',
    'audio-only': 'Audio only (for music or podcasts)',
  };

  // download mutaion
  const downloadMutation = useMutation({
    mutationFn: () => {
      if (!video || !selectedFormat) {
        throw new Error("Select a video resolution first.");
      }

      const id = `download-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const extension = selectedFormat.container
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase() || "mp4";

      return startDownload({
        id,
        url: selectedFormat.downloadUrl,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl ?? undefined,
        filename: `${video.title}.${extension}`,
        formatId: selectedFormat.formatId,
        resolutionLabel: selectedFormat.label,
      });
    },
    onSuccess: () => {
      router.push("/history");
    },
    onError: (error) => {
      Alert.alert("Download failed to start", error.message);
    },
  });

  return (
    <>
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <ScrollView
        className="flex-1 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950"
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 20
        }}
      >
        <View className="flex-row items-center justify-between mb-6">
          <Pressable
            onPress={() => setSidebarOpen(true)}
            className="rounded-2xl bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 px-4 py-3 shadow-lg shadow-black/20"
          >
            <Text className="text-2xl font-bold text-white">☰</Text>
          </Pressable>
        </View>

        <View className="mb-8">
          <Text className="text-4xl font-bold text-white tracking-tight">
            Downstream
          </Text>
          <Text className="mt-2 text-lg text-slate-400">
            Paste a video link and choose your quality.
          </Text>
        </View>

      <View className="rounded-3xl border border-slate-800/50 bg-slate-900/50 backdrop-blur-sm p-5 shadow-xl shadow-black/30">
        <Text className="mb-3 text-sm font-semibold text-slate-300 uppercase tracking-wider">
          Video URL
        </Text>

        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://example.com/video"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          multiline
          className="min-h-16 rounded-2xl border border-slate-700/50 bg-slate-950/50 px-4 py-4 text-white text-base shadow-inner"
        />

        <Pressable
          onPress={submit}
          disabled={resolver.isPending}
          className="mt-5 items-center rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-600 p-4 shadow-lg shadow-indigo-500/25"
        >
          {resolver.isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="font-bold text-white text-lg">Find video</Text>
          )}
        </Pressable>
      </View>

      {resolver.isError && (
        <View className="mt-5 rounded-2xl border border-red-900/50 bg-red-950/50 backdrop-blur-sm p-5 shadow-lg shadow-red-900/20">
          <Text className="font-semibold text-red-300 text-lg">
            Could not resolve this video
          </Text>
          <Text className="mt-2 text-sm text-red-200">
            {resolver.error.message}
          </Text>
          <Pressable onPress={() => resolver.mutate(url.trim())} className="mt-4">
            <Text className="font-bold text-white text-base">Try again</Text>
          </Pressable>
        </View>
      )}

      {video && (
        <View className="mt-8">
          {video.thumbnailUrl && (
            <Image
              source={{ uri: video.thumbnailUrl }}
              className="h-56 w-full rounded-3xl bg-slate-800 shadow-xl shadow-black/30"
              resizeMode="cover"
            />
          )}

          <Text className="mt-5 text-2xl font-bold text-white">
            {video.title}
          </Text>
          <Text className="mt-2 text-base text-slate-400">
            {Object.values(groupedFormats).flat().length} available formats
          </Text>

          <Text className="mb-4 mt-8 text-xl font-bold text-white">
            Select resolution
          </Text>

          {Object.entries(groupedFormats).map(([category, formats]) => {
            if (formats.length === 0) return null;

            return (
              <View key={category} className="mb-6">
                <View className="mb-3">
                  <Text className="text-lg font-bold text-white">
                    {categoryTitles[category]}
                  </Text>
                  <Text className="text-sm text-slate-400">
                    {categoryDescriptions[category]}
                  </Text>
                </View>

                {formats.map((format) => {
                  const selected = selectedFormat?.formatId === format.formatId;

                  return (
                    <Pressable
                      key={format.formatId}
                      onPress={() => setSelectedFormat(format)}

                      className={`mb-3 flex-row items-center justify-between rounded-2xl border p-5 shadow-md ${selected
                        ? "border-indigo-400/50 bg-indigo-950/50 backdrop-blur-sm shadow-indigo-500/20"
                        : "border-slate-800/50 bg-slate-900/50 backdrop-blur-sm shadow-black/10"
                        }`}
                    >
                      <View className="flex-1">
                        <Text className="font-semibold text-white text-lg">
                          {format.label}
                        </Text>
                        <Text className="mt-1 text-sm text-slate-400">
                          {format.container.toUpperCase()} · {formatBytes(format.fileSizeBytes)}
                        </Text>
                      </View>
                      <View className={`ml-4 rounded-xl px-3 py-1.5 ${selected ? 'bg-indigo-500' : 'bg-slate-700'}`}>
                        <Text className={`font-bold text-sm ${selected ? 'text-white' : 'text-slate-300'}`}>
                          {selected ? "✓" : "Select"}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            );
          })}

          {selectedFormat && (
            <Pressable
              onPress={() => downloadMutation.mutate()}
              disabled={downloadMutation.isPending}
              className="mt-6 items-center rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-600 p-5 shadow-xl shadow-indigo-500/30"
            >
              {
                downloadMutation.isPending ? (
                  <ActivityIndicator color={"#fff"} />
                ) : (
                  <Text className="font-bold text-white text-lg">
                    Download {selectedFormat.label}
                  </Text>
                )
              }
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
    </>
  );
}