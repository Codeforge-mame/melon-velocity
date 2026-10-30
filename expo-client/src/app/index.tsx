import { useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
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

import { resolveVideo } from "@/api/client";
import { startDownload } from "@/features/downloads/downloadManager";
import type { FormatCategory, VideoFormat } from "@/features/downloads/types";

const URL_PATTERN = /^https?:\/\/\S+$/i;

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return "Size unknown";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const CATEGORY_ORDER: FormatCategory[] = ["video", "video-only", "audio-only"];

const CATEGORY_TITLES: Record<FormatCategory, string> = {
  video: "Video + Audio",
  "video-only": "Video Only",
  "audio-only": "Audio Only",
};

const CATEGORY_DESCRIPTIONS: Record<FormatCategory, string> = {
  video: "Complete files with both video and audio",
  "video-only": "Video without audio (separate audio may be required)",
  "audio-only": "Audio only, for music or podcasts",
};

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);

  const resolver = useMutation({
    mutationFn: (value: string) => resolveVideo(value),
    onSuccess: () => setSelectedFormat(null),
  });

  const downloadMutation = useMutation({
    mutationFn: async () => {
      const video = resolver.data;
      if (!video || !selectedFormat) {
        throw new Error("Select a format first.");
      }
      const extension =
        selectedFormat.container.replace(/[^a-z0-9]/gi, "").toLowerCase() ||
        "mp4";
      const id = `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await startDownload({
        id,
        url: selectedFormat.downloadUrl,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        filename: `${video.title}.${extension}`,
        formatId: selectedFormat.formatId,
        resolutionLabel: selectedFormat.label,
      });
    },
    onSuccess: () => router.push("/history"),
    onError: (error) =>
      Alert.alert(
        "Download failed to start",
        error instanceof Error ? error.message : "Unknown error",
      ),
  });

  const submit = () => {
    const value = url.trim();
    if (!URL_PATTERN.test(value)) {
      Alert.alert("Invalid URL", "Paste a valid video URL beginning with http:// or https://.");
      return;
    }
    resolver.mutate(value);
  };

  const video = resolver.data;
  const duration = formatDuration(video?.durationSeconds ?? null);

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    formats: (video?.formats ?? []).filter((f) => f.category === category),
  })).filter((group) => group.formats.length > 0);

  return (
    <ScrollView
      className="flex-1 bg-slate-950"
      contentContainerStyle={{
        paddingTop: insets.top + 20,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 20,
      }}
    >
      <View className="mb-8 flex-row items-start justify-between">
        <View className="flex-1">
          <Text className="text-4xl font-bold tracking-tight text-white">
            MVelocity
          </Text>
          <Text className="mt-2 text-lg text-slate-400">
            Paste a video link and pick a resolution.
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/history")}
          className="ml-4 rounded-2xl border border-slate-700/50 bg-slate-800/60 px-4 py-3"
        >
          <Text className="font-semibold text-white">Downloads</Text>
        </Pressable>
      </View>

      <View className="rounded-3xl border border-slate-800/50 bg-slate-900/50 p-5">
        <Text className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
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
          className="min-h-16 rounded-2xl border border-slate-700/50 bg-slate-950/50 px-4 py-4 text-base text-white"
        />
        <Pressable
          onPress={submit}
          disabled={resolver.isPending}
          className="mt-5 items-center rounded-2xl bg-indigo-500 p-4 active:opacity-80"
        >
          {resolver.isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-lg font-bold text-white">Find video</Text>
          )}
        </Pressable>
      </View>

      {resolver.isError && (
        <View className="mt-5 rounded-2xl border border-red-900/50 bg-red-950/50 p-5">
          <Text className="text-lg font-semibold text-red-300">
            Could not resolve this video
          </Text>
          <Text className="mt-2 text-sm text-red-200">
            {resolver.error instanceof Error
              ? resolver.error.message
              : "Something went wrong."}
          </Text>
          <Pressable onPress={submit} className="mt-4">
            <Text className="text-base font-bold text-white">Try again</Text>
          </Pressable>
        </View>
      )}

      {video && (
        <View className="mt-8">
          {video.thumbnailUrl ? (
            <Image
              source={{ uri: video.thumbnailUrl }}
              className="h-48 w-full rounded-2xl bg-slate-800"
              resizeMode="cover"
            />
          ) : null}
          <Text className="mt-4 text-xl font-bold text-white">{video.title}</Text>
          {duration ? (
            <Text className="mt-1 text-sm text-slate-400">Duration {duration}</Text>
          ) : null}

          {grouped.map((group) => (
            <View key={group.category} className="mt-6">
              <Text className="text-base font-bold text-white">
                {CATEGORY_TITLES[group.category]}
              </Text>
              <Text className="mb-3 mt-1 text-xs text-slate-400">
                {CATEGORY_DESCRIPTIONS[group.category]}
              </Text>

              {group.formats.map((format) => {
                const active = selectedFormat?.formatId === format.formatId;
                return (
                  <Pressable
                    key={`${group.category}-${format.formatId}-${format.downloadUrl}`}
                    onPress={() => setSelectedFormat(format)}
                    className={`mb-2 rounded-2xl border p-4 ${
                      active
                        ? "border-indigo-500 bg-indigo-500/15"
                        : "border-slate-800/60 bg-slate-900/50"
                    }`}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-base font-semibold text-white">
                        {format.label}
                      </Text>
                      <Text className="text-xs uppercase text-slate-400">
                        {format.container}
                      </Text>
                    </View>
                    <Text className="mt-1 text-xs text-slate-400">
                      {formatBytes(format.fileSizeBytes)}
                      {format.requiresAuthorization ? " • requires authorization" : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Pressable
            onPress={() => downloadMutation.mutate()}
            disabled={!selectedFormat || downloadMutation.isPending}
            className={`mt-6 items-center rounded-2xl p-4 ${
              selectedFormat ? "bg-indigo-500 active:opacity-80" : "bg-slate-800"
            }`}
          >
            {downloadMutation.isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text
                className={`text-lg font-bold ${
                  selectedFormat ? "text-white" : "text-slate-500"
                }`}
              >
                {selectedFormat ? `Download ${selectedFormat.label}` : "Select a format"}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}
