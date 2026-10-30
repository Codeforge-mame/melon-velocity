import { useRouter } from "expo-router";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  clearCompleted,
  pauseDownload,
  removeDownload,
  resumeDownload,
} from "@/features/downloads/downloadManager";
import type { DownloadRecord } from "@/features/downloads/types";
import { useDownloads } from "@/features/downloads/useDownloads";

function progress(record: DownloadRecord): number {
  if (record.status === "completed") return 1;
  if (!record.totalBytes) return 0;
  return Math.min(1, record.bytesWritten / record.totalBytes);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_COLORS: Record<DownloadRecord["status"], string> = {
  queued: "text-slate-400",
  downloading: "text-indigo-300",
  paused: "text-amber-300",
  completed: "text-emerald-400",
  error: "text-red-400",
};

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const downloads = useDownloads();

  const renderItem = ({ item }: { item: DownloadRecord }) => {
    const ratio = progress(item);
    const canPause = item.status === "downloading" || item.status === "queued";
    const canResume = item.status === "paused" || item.status === "error";

    return (
      <View className="mb-3 rounded-2xl border border-slate-800/60 bg-slate-900/50 p-4">
        <View className="flex-row items-center justify-between">
          <Text
            numberOfLines={1}
            className="mr-3 flex-1 text-base font-semibold text-white"
          >
            {item.title}
          </Text>
          <Text
            className={`text-xs font-semibold uppercase ${STATUS_COLORS[item.status]}`}
          >
            {item.status}
          </Text>
        </View>

        <Text className="mt-1 text-xs text-slate-400">
          {item.resolutionLabel}
          {item.totalBytes > 0
            ? ` • ${formatBytes(item.bytesWritten)} / ${formatBytes(item.totalBytes)}`
            : ""}
        </Text>

        {(item.status === "downloading" || item.status === "paused") && (
          <View className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <View
              className={`h-full rounded-full ${
                item.status === "paused" ? "bg-amber-400" : "bg-indigo-500"
              }`}
              style={{ width: `${ratio * 100}%` }}
            />
          </View>
        )}

        {item.error ? (
          <Text className="mt-2 text-xs text-red-300">{item.error}</Text>
        ) : null}

        <View className="mt-3 flex-row items-center gap-4">
          {canPause && (
            <Pressable onPress={() => void pauseDownload(item.id)}>
              <Text className="text-xs font-semibold text-amber-300">Pause</Text>
            </Pressable>
          )}
          {canResume && (
            <Pressable onPress={() => void resumeDownload(item.id)}>
              <Text className="text-xs font-semibold text-indigo-300">
                {item.resumeData ? "Resume" : "Restart"}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() =>
              Alert.alert("Remove", "Remove this entry from the list?", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () => void removeDownload(item.id),
                },
              ])
            }
          >
            <Text className="text-xs font-semibold text-slate-400">Remove</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-slate-950">
      <View
        className="flex-row items-center justify-between px-5 pb-4"
        style={{ paddingTop: insets.top + 16 }}
      >
        <View className="flex-row items-center">
          <Pressable
            onPress={() => router.back()}
            className="mr-4 rounded-2xl border border-slate-700/50 bg-slate-800/60 px-4 py-3"
          >
            <Text className="font-semibold text-white">Back</Text>
          </Pressable>
          <Text className="text-2xl font-bold text-white">Downloads</Text>
        </View>
        {downloads.some((d) => d.status === "completed") && (
          <Pressable onPress={() => void clearCompleted()}>
            <Text className="text-sm font-semibold text-slate-400">
              Clear done
            </Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={downloads}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 40,
        }}
        ListEmptyComponent={
          <View className="mt-20 items-center">
            <Text className="text-base text-slate-400">No downloads yet.</Text>
          </View>
        }
      />
    </View>
  );
}
