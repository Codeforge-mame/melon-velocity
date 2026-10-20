import { useMutation } from "@tanstack/react-query";
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

import { resolveVideo } from "../app/api/videos";
import type { VideoFormat } from "../features/downloads/types";
import { startDownload } from "@/features/downloads/downloadManager";
import { DownloadQueue } from "@/features/downloads/downloadQueue";
import { useRouter } from "expo-router";

function formatBytes(bytes: number | null) {
  if (bytes == null) return "Size unknown";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HomeScreen() {
  const [url, setUrl] = useState("");
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);
  const router = useRouter();

  const resolver = useMutation({
    mutationFn: resolveVideo,
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
        filename: `${video.title}.${extension}`,
        formatId: selectedFormat.formatId,
        resolutionLabel: selectedFormat.label,
      });
    },
    onSuccess: () => {
      Alert.alert(
        "Download started",
        "Your video has been added to the download queue.",
      );
    },
    onError: (error) => {
      Alert.alert("Download failed to start", error.message);
    },
  });

  return (
    <ScrollView className="flex-1 bg-slate-950" contentContainerClassName="p-5 pb-12">

      <Pressable
        onPress={() => router.push("/history")}
        className="mb-4 rounded-xl bg-slate-800 px-4 py-3"
      >
        <Text className="text-center font-semibold text-white">
          View Download history
        </Text>
      </Pressable>

      <Text className="mt-8 text-3xl font-bold text-white">
        Downstream
      </Text>
      <Text className="mt-2 text-base text-slate-400">
        Paste a video link and choose your quality.
      </Text>

      <View className="mt-7 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <Text className="mb-3 text-sm font-semibold text-slate-300">
          VIDEO URL
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
          className="min-h-14 rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white"
        />

        <Pressable
          onPress={submit}
          disabled={resolver.isPending}
          className="mt-4 items-center rounded-xl bg-indigo-500 p-4"
        >
          {resolver.isPending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="font-bold text-white">Find video</Text>
          )}
        </Pressable>
      </View>

      {resolver.isError && (
        <View className="mt-5 rounded-xl border border-red-900 bg-red-950 p-4">
          <Text className="font-semibold text-red-300">
            Could not resolve this video
          </Text>
          <Text className="mt-2 text-sm text-red-200">
            {resolver.error.message}
          </Text>
          <Pressable onPress={() => resolver.mutate(url.trim())} className="mt-3">
            <Text className="font-bold text-white">Try again</Text>
          </Pressable>
        </View>
      )}

      {video && (
        <View className="mt-6">
          {video.thumbnailUrl && (
            <Image
              source={{ uri: video.thumbnailUrl }}
              className="h-48 w-full rounded-2xl bg-slate-800"
              resizeMode="cover"
            />
          )}

          <Text className="mt-4 text-xl font-bold text-white">
            {video.title}
          </Text>
          <Text className="mt-2 text-sm text-slate-400">
            {video.formats.length} available formats
          </Text>

          <Text className="mb-3 mt-6 text-lg font-bold text-white">
            Select resolution
          </Text>

          {video.formats.map((format) => {
            const selected = selectedFormat?.formatId === format.formatId;

            return (
              <Pressable
                key={format.formatId}
                onPress={() => setSelectedFormat(format)}

                className={`mb-3 flex-row items-center justify-between rounded-xl border p-4 ${selected
                  ? "border-indigo-400 bg-indigo-950"
                  : "border-slate-800 bg-slate-900"
                  }`}
              >
                <View className="flex-1">
                  <Text className="font-semibold text-white">
                    {format.label}
                  </Text>
                  <Text className="mt-1 text-sm text-slate-400">
                    {format.container.toUpperCase()} · {formatBytes(format.fileSizeBytes)}
                  </Text>
                </View>
                <Text className="ml-3 font-bold text-indigo-300">
                  {selected ? "Selected" : "Select"}
                </Text>
              </Pressable>
            );
          })}

          {selectedFormat && (
            <Pressable
              onPress={() => downloadMutation.mutate()}
              disabled={downloadMutation.isPending}
              className="mt-4 items-center rounded-xl bg-indigo-500 p-4"
            >
              {
                downloadMutation.isPending ? (
                  <ActivityIndicator color={"#fff"} />
                ) : (
                  <Text className="font-bold text-white">
                    Download {selectedFormat.label}
                  </Text>
                )
              }
            </Pressable>
          )}
        </View>
      )}
      <DownloadQueue />
    </ScrollView>
  );
}