import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    Modal,
    Pressable,
    ScrollView,
    Share,
    Text,
    View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDownloads, DownloadRow } from "../features/downloads/useDownloads";
import {
    pauseDownload,
    resumeDownload,
    retryDownload,
    retryGallerySave,
    deleteDownload,
    deleteFromGallery,
} from "../features/downloads/downloadManager";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";

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
    const insets = useSafeAreaInsets();
    const [filter, setFilter] = useState<Filter>("downloading");
    const [selectedItem, setSelectedItem] = useState<DownloadRow | null>(null);
    const queryClient = useQueryClient();
    const { data: downloads = [], isLoading, error } = useDownloads();

    const handleShare = async (item: DownloadRow) => {
        try {
            await Share.share({
                title: item.title || item.file_name,
                message: `Check out this video: ${item.title || item.file_name}`,
            });
        } catch (err: any) {
            Alert.alert("Error sharing", err.message);
        }
    };

    const handlePlay = async (item: DownloadRow) => {
        if (!item.file_uri) {
            Alert.alert("File unavailable", "The video file location is not recorded.");
            return;
        }
        try {
            const uri = item.file_uri.startsWith("file://") ? item.file_uri : `file://${item.file_uri}`;
            await WebBrowser.openBrowserAsync(uri);
        } catch (err: any) {
            Alert.alert("Error playing video", err.message);
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

    const controlMutation = useMutation({
        mutationFn: async ({
            id,
            action,
        }: {
            id: string;
            action: "pause" | "resume";
        }) => {
            if (action === "pause") {
                await pauseDownload(id);
            } else {
                await resumeDownload(id);
            }
        },
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ["downloads"] }),
        onError: (error) => Alert.alert("Download control failed", error.message),
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

    const deleteDownloadMutation = useMutation({
        mutationFn: deleteDownload,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: ["downloads"],
            });
            Alert.alert("Deleted", "Video removed from app library.");
            setSelectedItem(null);
        },
        onError: (error) => {
            Alert.alert(
                "Delete failed",
                error instanceof Error ? error.message : "Please try again."
            );
        },
    });

    const deleteFromGalleryMutation = useMutation({
        mutationFn: deleteFromGallery,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: ["downloads"],
            });
            Alert.alert("Deleted", "Video removed from device gallery.");
            setSelectedItem(null);
        },
        onError: (error) => {
            Alert.alert(
                "Gallery delete failed",
                error instanceof Error ? error.message : "Please try again."
            );
        },
    });

    return (
        <View className="flex-1 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
            <ScrollView
                className="flex-1"
                contentContainerStyle={{
                    paddingTop: insets.top + 20,
                    paddingBottom: insets.bottom + 40,
                    paddingHorizontal: 16
                }}
            >
                <View className="mb-6 flex-row items-center justify-between">
                    <Pressable
                        onPress={() => router.back()}
                        className="rounded-2xl bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 px-4 py-3 shadow-lg shadow-black/20"
                    >
                        <Text className="text-indigo-400 font-semibold text-base">← Back</Text>
                    </Pressable>
                </View>

                <View className="mb-8">
                    <Text className="text-4xl font-bold text-white tracking-tight">
                        Download history
                    </Text>
                    <Text className="mt-2 text-lg text-slate-400">
                        Track active jobs and find completed videos.
                    </Text>
                </View>

                <View className="mb-6 flex-row rounded-2xl bg-slate-900/50 backdrop-blur-sm border border-slate-800/50 p-1.5 shadow-lg shadow-black/20">
                    {(["downloading", "downloaded"] as const).map((item) => (
                        <Pressable
                            key={item}
                            onPress={() => setFilter(item)}
                            className={`flex-1 rounded-xl px-3 py-3 ${filter === item ? "bg-gradient-to-r from-indigo-500 to-purple-600 shadow-md" : ""
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
                        className={`flex-1 rounded-xl px-3 py-3 ${filter === "failed" ? "bg-gradient-to-r from-red-500 to-orange-600 shadow-md" : "bg-slate-800/50"
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
                    <View className="flex-1 items-center justify-center py-12">
                        <ActivityIndicator size="large" color="#818cf8" />
                        <Text className="mt-4 text-slate-400">Loading downloads...</Text>
                    </View>
                )}

                {error && (
                    <View className="rounded-2xl border border-red-900/50 bg-red-950/50 backdrop-blur-sm p-5 shadow-lg shadow-red-900/20">
                        <Text className="text-center text-red-300 text-lg font-semibold">
                            Could not load download history.
                        </Text>
                    </View>
                )}

                {!isLoading && visibleDownloads.length === 0 && (
                    <View className="rounded-3xl border border-slate-800/50 bg-slate-900/50 backdrop-blur-sm p-8 shadow-xl shadow-black/30">
                        <Text className="text-center text-3xl mb-4">
                            {filter === "downloaded" ? "📁" : filter === "failed" ? "⚠️" : "📥"}
                        </Text>
                        <Text className="text-center text-xl font-semibold text-white">
                            Nothing here yet
                        </Text>
                        <Text className="mt-3 text-center text-slate-400 text-base">
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
                            className="mb-4 overflow-hidden rounded-3xl border border-slate-800/50 bg-slate-900/50 backdrop-blur-sm shadow-lg shadow-black/20"
                        >
                            <View className="flex-row p-4">
                                {item.thumbnail_url && (
                                    <Image
                                        source={{ uri: item.thumbnail_url }}
                                        className="mr-4 h-24 w-24 rounded-2xl bg-slate-800 shadow-md"
                                        resizeMode="cover"
                                    />
                                )}
                                <View className="flex-1">
                                    <View className="flex-row justify-between">
                                        <View className="flex-1">
                                            <Text numberOfLines={2} className="text-lg font-semibold text-white">
                                                {item.title || item.file_name}
                                            </Text>
                                        </View>
                                        {item.status === "completed" && (
                                            <Pressable
                                                onPress={() => setSelectedItem(item)}
                                                className="ml-3 h-9 w-9 items-center justify-center rounded-full bg-slate-800/50 border border-slate-700/50"
                                            >
                                                <Text className="text-xl font-bold text-slate-300">⋮</Text>
                                            </Pressable>
                                        )}
                                    </View>

                                    <Text className="mt-2 text-sm text-slate-400">
                                        {item.file_name}
                                    </Text>

                                    <View className={`mt-3 rounded-lg px-3 py-1 self-start ${
                                        item.status === "completed" ? "bg-green-500/20" :
                                        item.status === "failed" ? "bg-red-500/20" :
                                        item.status === "paused" ? "bg-yellow-500/20" : "bg-indigo-500/20"
                                    }`}>
                                        <Text className={`text-xs font-semibold ${
                                            item.status === "completed" ? "text-green-400" :
                                            item.status === "failed" ? "text-red-400" :
                                            item.status === "paused" ? "text-yellow-400" : "text-indigo-400"
                                        }`}>
                                            {item.status.toUpperCase()}
                                        </Text>
                                    </View>
                                </View>
                            </View>

                            <View className="px-4 pb-4">
                                {filter === "downloading" && (
                                    <>
                                        <Text className="text-sm text-slate-400">
                                            {item.status === "queued" && "⏳ Waiting to start"}
                                            {item.status === "downloading" && "⬇️ Downloading"}
                                            {item.status === "paused" && "⏸️ Paused"}
                                            {item.status === "completed" && "✅ Downloaded"}
                                        </Text>

                                        <View className="mt-3 h-3 overflow-hidden rounded-full bg-slate-800">
                                            <View
                                                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-600"
                                                style={{ width: `${progress ?? 0}%` }}
                                            />
                                        </View>

                                        <View className="mt-2 flex-row items-center justify-between">
                                            <Text className="text-sm text-slate-400">
                                                {formatBytes(item.downloaded_bytes)}
                                                {item.total_bytes
                                                    ? `/ ${formatBytes(item.total_bytes)}`
                                                    : ""}
                                                {progress !== null ? ` · ${progress}% ` : ""}
                                            </Text>
                                        </View>

                                        <View className="mt-4 flex-row gap-3">
                                            {item.status === "downloading" && (
                                                <Pressable
                                                    onPress={() =>
                                                        controlMutation.mutate({ id: item.id, action: "pause" })
                                                    }
                                                    className="rounded-xl bg-slate-700/50 border border-slate-600/50 px-4 py-2.5 shadow-md"
                                                >
                                                    <Text className="font-semibold text-white text-sm">Pause</Text>
                                                </Pressable>
                                            )}

                                            {item.status === "paused" && (
                                                <Pressable
                                                    onPress={() =>
                                                        controlMutation.mutate({ id: item.id, action: "resume" })
                                                    }
                                                    className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-2.5 shadow-md shadow-indigo-500/25"
                                                >
                                                    <Text className="font-semibold text-white text-sm">Resume</Text>
                                                </Pressable>
                                            )}

                                            <Pressable
                                                onPress={() => retryMutation.mutate(item.id)}
                                                className="rounded-xl bg-slate-800/50 border border-slate-700/50 px-4 py-2.5 shadow-md"
                                            >
                                                <Text className="font-semibold text-white text-sm">Restart</Text>
                                            </Pressable>
                                        </View>
                                    </>
                                )}

                                {item.status === "failed" && (
                                    <>
                                        <Text className="mt-2 text-sm text-red-400">
                                            ❌ {item.error_message || "Download failed."}
                                        </Text>

                                        <Pressable
                                            disabled={retryMutation.isPending}
                                            onPress={() => retryMutation.mutate(item.id)}
                                            className="mt-4 self-start rounded-xl bg-gradient-to-r from-red-500 to-orange-600 px-5 py-2.5 shadow-md shadow-red-500/25"
                                        >
                                            <Text className="font-semibold text-white text-sm">
                                                Retry download
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                            </View>
                        </View>
                    );
                })}
            </ScrollView>

            <Modal
                visible={!!selectedItem}
                transparent
                animationType="slide"
                onRequestClose={() => setSelectedItem(null)}
            >
                <Pressable
                    className="flex-1 bg-black/60 justify-end"
                    onPress={() => setSelectedItem(null)}
                >
                    <View className="bg-slate-900/95 backdrop-blur-xl rounded-t-[2.5rem] p-6 pb-10 border-t border-slate-800/50 shadow-2xl">
                        <View className="w-12 h-1.5 bg-slate-700 rounded-full self-center mb-6" />
                        <Text className="text-white text-2xl font-bold mb-6" numberOfLines={1}>
                            {selectedItem?.title || "Options"}
                        </Text>

                        <Pressable
                            onPress={() => {
                                if (selectedItem) handlePlay(selectedItem);
                                setSelectedItem(null);
                            }}
                            className="flex-row items-center py-4 border-b border-slate-800/50"
                        >
                            <Text className="text-2xl mr-4">▶️</Text>
                            <Text className="text-white text-lg font-semibold">Play Video</Text>
                        </Pressable>

                        <Pressable
                            onPress={() => {
                                if (selectedItem) handleShare(selectedItem);
                                setSelectedItem(null);
                            }}
                            className="flex-row items-center py-4 border-b border-slate-800/50"
                        >
                            <Text className="text-2xl mr-4">📤</Text>
                            <Text className="text-white text-lg font-semibold">Share Video</Text>
                        </Pressable>

                        {selectedItem?.gallery_saved !== 1 && (
                            <Pressable
                                onPress={() => {
                                    if (selectedItem) gallerySaveMutation.mutate(selectedItem.id);
                                    setSelectedItem(null);
                                }}
                                className="flex-row items-center py-4 border-b border-slate-800/50"
                            >
                                <Text className="text-2xl mr-4">🖼️</Text>
                                <Text className="text-white text-lg font-semibold">Save to Gallery</Text>
                            </Pressable>
                        )}

                        {selectedItem?.gallery_saved === 1 && (
                            <Pressable
                                onPress={() => {
                                    Alert.alert(
                                        "Delete from Gallery",
                                        "Are you sure you want to remove this video from your device gallery?",
                                        [
                                            { text: "Cancel", style: "cancel" },
                                            {
                                                text: "Delete",
                                                style: "destructive",
                                                onPress: () => {
                                                    if (selectedItem) deleteFromGalleryMutation.mutate(selectedItem.id);
                                                }
                                            }
                                        ]
                                    );
                                }}
                                className="flex-row items-center py-4 border-b border-slate-800/50"
                            >
                                <Text className="text-2xl mr-4">🗑️</Text>
                                <Text className="text-red-400 text-lg font-semibold">Delete from Gallery</Text>
                            </Pressable>
                        )}

                        <Pressable
                            onPress={() => {
                                Alert.alert(
                                    "Delete from Library",
                                    "Are you sure you want to remove this video from the app library?",
                                    [
                                        { text: "Cancel", style: "cancel" },
                                        {
                                            text: "Delete",
                                            style: "destructive",
                                            onPress: () => {
                                                if (selectedItem) deleteDownloadMutation.mutate(selectedItem.id);
                                            }
                                        }
                                    ]
                                );
                            }}
                            className="flex-row items-center py-4 border-b border-slate-800/50"
                        >
                            <Text className="text-2xl mr-4">🗑️</Text>
                            <Text className="text-red-400 text-lg font-semibold">Delete from Library</Text>
                        </Pressable>

                        <Pressable
                            onPress={() => setSelectedItem(null)}
                            className="mt-6 py-4 items-center bg-slate-800/50 border border-slate-700/50 rounded-2xl shadow-lg"
                        >
                            <Text className="text-white font-bold text-lg">Cancel</Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Modal>
        </View>
    );
}
