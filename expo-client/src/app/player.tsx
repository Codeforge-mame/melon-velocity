import { useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function PlayerScreen() {
  const { uri, title } = useLocalSearchParams<{ uri?: string; title?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const source = typeof uri === "string" ? uri : "";

  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.play();
  });

  return (
    <View className="flex-1 bg-black">
      <View
        className="flex-row items-center px-5 pb-4"
        style={{ paddingTop: insets.top + 12 }}
      >
        <Pressable
          onPress={() => router.back()}
          className="mr-4 rounded-2xl border border-slate-700/60 bg-slate-800/60 px-4 py-2"
        >
          <Text className="font-semibold text-white">Close</Text>
        </Pressable>
        <Text numberOfLines={1} className="flex-1 text-base font-semibold text-white">
          {typeof title === "string" ? title : "Playback"}
        </Text>
      </View>

      <View className="flex-1 justify-center">
        {source ? (
          <VideoView
            player={player}
            className="h-full w-full"
            style={{ flex: 1 }}
            nativeControls
            contentFit="contain"
            allowsPictureInPicture
          />
        ) : (
          <Text className="text-center text-slate-400">
            No playable file is available.
          </Text>
        )}
      </View>
    </View>
  );
}
