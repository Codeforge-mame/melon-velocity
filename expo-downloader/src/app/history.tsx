import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    Share,
    Text,
    View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDownloads, DownloadRow } from "../features/downloads/useDownloads";
import { retryDownload } from "../features/downloads/downloadManager";
import { retryGallerySave } from "../features/downloads/downloadManager";

type Filter = "downloading" | "downloaded" | "failed";

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function HistoryScreen() {
    const router = useRouter();
    const [filter, setFilter] = useState<Filter>("downloading");
    const queryClient = useQueryClient();
    const { data: downloads = [], isLoading, error } = useDownloads();

    const handleOpenOrShare = async (item: DownloadRow) => {
        if (!item.file_uri) {
            Alert.alert("File unavailable", "The video file location is not recorded.");
            return;
        }
        try {
            await Share.share({
                title: item.title || item.file_name,
                url: item.file_uri.startsWith("file://") ? item.file_uri : `file://${item.file_uri}`,
            });
        } catch (err: any) {
            Alert.alert("Error opening video", err.message);
        }
    };

    const retryMutation = useMutation({
        mutationFn: retryDownload,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: ["downloads"],
            });
            Alert.alert("Retry started", "A new download has been queued.");
        },
        onError: (err: Error) => {
            Alert.alert("Retry failed", err.message);
        },
    });

    const visibleDownloads = downloads.filter((item) => {
        if (filter === "downloaded") {
            return item.status === "completed";
        }

        if (filter === "failed") {
            return item.status === "failed";
        }

        return ["queued", "downloading", "paused"].includes(item.status);
    });

    const gallerySaveMutation = useMutation({
        mutationFn: retryGallerySave,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: ["downloads"],
            });
            Alert.alert("Saved", "Video saved to device gallery successfully.");
        },
        onError: (error) => {
            Alert.alert(
                "Gallery save failed",
                error instanceof Error ? error.message : "Please try again."
            );
        },
    });

    return (
        <ScrollView
            className="flex-1 bg-slate-950 px-4 pt-5"
            contentContainerStyle={{ paddingBottom: 40 }}
        >
            <View className="mb-4 flex-row items-center justify-between">
                <Pressable
                    onPress={() => router.back()}
                    className="rounded-xl bg-slate-900 px-3 py-2 border border-slate-800"
                >
                    <Text className="text-indigo-400 font-semibold">← Back</Text>
                </Pressable>
            </View>

            <Text className="mb-2 text-3xl font-bold text-white">
                Download history
            </Text>
            <Text className="mb-5 text-slate-400">
                Track active jobs and find completed videos.
            </Text>

            <View className="mb-5 flex-row rounded-xl bg-slate-900 p-1">
                {(["downloading", "downloaded"] as const).map((item) => (
                    <Pressable
                        key={item}
                        onPress={() => setFilter(item)}
                        className={`flex-1 rounded-lg px-3 py-3 ${filter === item ? "bg-indigo-600" : ""
                            }`}
                    >
                        <Text
                            className={`text-center font-semibold ${filter === item ? "text-white" : "text-slate-400"
                                }`}
                        >
                            {item === "downloading" ? "Downloading" : "Downloaded"}
                        </Text>
                    </Pressable>
                ))}
                <Pressable
                    onPress={() => setFilter("failed")}
                    className={`flex-1 rounded-xl px-3 py-3 ${filter === "failed" ? "bg-indigo-600" : "bg-slate-800"
                        }`}
                >
                    <Text
                        className={`text-center font-semibold ${filter === "failed" ? "text-white" : "text-slate-300"
                            }`}
                    >
                        Failed
                    </Text>
                </Pressable>
            </View>

            {isLoading && (
                <ActivityIndicator size="large" color="#818cf8" />
            )}

            {error && (
                <Text className="text-red-400">
                    Could not load download history.
                </Text>
            )}

            {!isLoading && visibleDownloads.length === 0 && (
                <View className="rounded-2xl bg-slate-900 p-6">
                    <Text className="text-center text-lg font-semibold text-white">
                        Nothing here yet
                    </Text>
                    <Text className="mt-2 text-center text-slate-400">
                        {filter === "downloaded"
                            ? "Completed videos will appear here."
                            : filter === "failed"
                            ? "Failed downloads will appear here."
                            : "Active downloads will appear here."}
                    </Text>
                </View>
            )}

            {visibleDownloads.map((item) => {
                const progress =
                    item.total_bytes && item.total_bytes > 0
                        ? Math.min(
                            100,
                            Math.round(
                                (item.downloaded_bytes / item.total_bytes) * 100,
                            ),
                        )
                        : null;

                return (
                    <View
                        key={item.id}
                        className="mb-3 rounded-2xl border border-slate-800 bg-slate-900 p-4"
                    >
                        <Text className="text-base font-semibold text-white">
                            {item.title || item.file_name}
                        </Text>

                        <Text className="mt-1 text-sm text-slate-400">
                            {item.file_name}
                        </Text>

                        <Text className="mt-2 text-sm text-indigo-300">
                            {item.status.toUpperCase()}
                        </Text>

                        {filter === "downloading" && (
                            <>
                                <Text className="mt-2 text-xs text-slate-400">
                                    {item.status === "queued" && "Waiting to start"}
                                    {item.status === "downloading" && "Downloading"}
                                    {item.status === "paused" && "Paused"}
                                    {item.status === "completed" && "Downloaded"}
                                </Text>

                                <View className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700">
                                    <View
                                        className="h-full rounded-full bg-indigo-500"
                                        style={{ width: `${progress ?? 0}%` }}
                                    />
                                </View>

                                <Text className="mt-2 text-sm text-slate-400">
                                    {formatBytes(item.downloaded_bytes)}
                                    {item.total_bytes
                                        ? `/ ${formatBytes(item.total_bytes)}`
                                        : ""}
                                    {progress !== null ? `· ${progress}% ` : ""}
                                </Text>
                            </>
                        )}

                        {item.status === "failed" && (
                            <>
                                <Text className="mt-2 text-sm text-red-400">
                                    {item.error_message || "Download failed."}
                                </Text>

                                <Pressable
                                    disabled={retryMutation.isPending}
                                    onPress={() => retryMutation.mutate(item.id)}
                                    className="mt-3 self-start rounded-lg bg-indigo-600 px-4 py-2"
                                >
                                    <Text className="font-semibold text-white">
                                        Retry download
                                    </Text>
                                </Pressable>
                            </>
                        )}

                        {item.status === "completed" && (
                            <View className="mt-3 flex-row flex-wrap gap-2">
                                <Pressable
                                    onPress={() => handleOpenOrShare(item)}
                                    className="rounded-lg bg-indigo-600 px-4 py-2"
                                >
                                    <Text className="font-semibold text-white">
                                        ▶ Play / Share
                                    </Text>
                                </Pressable>

                                {item.gallery_saved !== 1 && (
                                    <Pressable
                                        onPress={() => gallerySaveMutation.mutate(item.id)}
                                        disabled={gallerySaveMutation.isPending}
                                        className="rounded-lg bg-blue-600 px-4 py-2"
                                    >
                                        <Text className="font-semibold text-white">
                                            {gallerySaveMutation.isPending ? "Saving to gallery…" : "Save to gallery"}
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        )}
                    </View>
                );
            })}
        </ScrollView>
    );
}