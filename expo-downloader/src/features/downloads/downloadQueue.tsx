import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, Text, View } from "react-native";

import { pauseDownload, resumeDownload } from "./downloadManager";
import { useDownloads } from "./useDownloads";

export function DownloadQueue() {
    const queryClient = useQueryClient();
    const { data: downloads = [], isLoading } = useDownloads();

    const control = useMutation({
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

    if (isLoading) {
        return <Text className="mt-6 text-slate-400">Loading downloads…</Text>;
    }

    return (
        <View className="mt-8">
            <Text className="mb-4 text-xl font-bold text-white">
                Downloads ({downloads.length})
            </Text>

            {downloads.length === 0 && (
                <Text className="text-slate-400">
                    Your downloads will appear here.
                </Text>
            )}

            {downloads.map((item) => {
                const total = item.total_bytes ?? 0;
                const percent =
                    total > 0
                        ? Math.min(100, (item.downloaded_bytes / total) * 100)
                        : 0;

                return (
                    <View
                        key={item.id}
                        className="mb-3 rounded-xl border border-slate-800 bg-slate-900 p-4"
                    >
                        <Text numberOfLines={2} className="font-semibold text-white">
                            {item.title ?? item.file_name}
                        </Text>

                        <Text className="mt-1 text-sm capitalize text-slate-400">
                            {item.status}
                            {total > 0 ? ` · ${percent.toFixed(0)}%` : ""}
                        </Text>

                        {total > 0 && (
                            <View className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700">
                                <View
                                    className="h-2 bg-indigo-400"
                                    style={{ width: `${percent}%` }}
                                />
                            </View>
                        )}

                        {item.error_message && (
                            <Text className="mt-2 text-sm text-red-300">
                                {item.error_message}
                            </Text>
                        )}

                        {item.status === "downloading" && (
                            <Pressable
                                onPress={() =>
                                    control.mutate({ id: item.id, action: "pause" })
                                }
                                className="mt-3 self-start rounded-lg bg-slate-700 px-4 py-2"
                            >
                                <Text className="font-semibold text-white">Pause</Text>
                            </Pressable>
                        )}

                        {item.status === "paused" && (
                            <Pressable
                                onPress={() =>
                                    control.mutate({ id: item.id, action: "resume" })
                                }
                                className="mt-3 self-start rounded-lg bg-indigo-500 px-4 py-2"
                            >
                                <Text className="font-semibold text-white">Resume</Text>
                            </Pressable>
                        )}
                    </View>
                );
            })}
        </View>
    );
}