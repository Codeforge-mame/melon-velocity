import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

const PLATFORMS = [
  {
    name: 'YouTube',
    color: '#fb4b4b',
    steps: [
      'Sign in to your own YouTube account in a trusted browser.',
      'Use a reputable cookie-export tool to export only a Netscape-format cookie file for youtube.com.',
      'In MeloStream Settings, choose YouTube and paste the exported cookie text into the YouTube session field.',
      'Save the session, select YouTube mode, then analyze and download a video you are allowed to access.',
    ],
  },
  {
    name: 'TikTok',
    color: '#2dd4bf',
    steps: [
      'Sign in to your own TikTok account in a trusted browser.',
      'Export a Netscape-format cookie file for tiktok.com using a tool you trust.',
      'In MeloStream Settings, choose TikTok, paste the cookie text, and save the session.',
      'Select TikTok mode before analyzing a TikTok link.',
    ],
  },
  {
    name: 'Telegram',
    color: '#38bdf8',
    steps: [
      'Start with a public Telegram post or media link and select Telegram mode.',
      'If a link needs account access, the current app accepts a Netscape-format session in Settings, but Telegram web sessions may not work with every yt-dlp link.',
      'MeloStream does not ask for your Telegram password or verification code. Do not paste either into the app.',
    ],
  },
];

export default function SocialGuideScreen() {
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-slate-950 px-4 pt-4">
      <View className="flex-row items-center justify-between mb-5">
        <TouchableOpacity
          onPress={() => router.back()}
          className="bg-slate-900 border border-slate-800 px-3 py-2 rounded-full"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-indigo-300 text-xs font-bold">← Back</Text>
        </TouchableOpacity>
        <Text className="text-white text-lg font-black">Social account guide</Text>
        <View className="w-12" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 28 }}>
        <View className="bg-slate-900 border border-slate-800 rounded-3xl p-4 mb-5">
          <Text className="text-white text-base font-black mb-2">Connect a session</Text>
          <Text className="text-slate-300 text-xs leading-5">
            Social-platform access is optional. Create or sign in to your MeloStream account, open Settings, and use the session field for the platform you want. Cookie sessions are sensitive: only import your own account, use a trusted exporter, and never share the exported text.
          </Text>
        </View>

        {PLATFORMS.map((platform) => (
          <View key={platform.name} className="bg-slate-900 border border-slate-800 rounded-3xl p-4 mb-4">
            <Text style={{ color: platform.color }} className="text-base font-black mb-3">
              {platform.name}
            </Text>
            {platform.steps.map((step, index) => (
              <View key={step} className="flex-row mb-3">
                <View className="w-5 h-5 rounded-full bg-slate-800 items-center justify-center mr-2">
                  <Text className="text-slate-200 text-[10px] font-bold">{index + 1}</Text>
                </View>
                <Text className="flex-1 text-slate-300 text-xs leading-5">{step}</Text>
              </View>
            ))}
          </View>
        ))}

        <View className="bg-amber-950/40 border border-amber-800/70 rounded-2xl p-4 mb-4">
          <Text className="text-amber-200 text-xs font-black mb-2">Keep your account safe</Text>
          <Text className="text-amber-100/80 text-xs leading-5">
            Never enter a platform password, one-time code, or recovery key into MeloStream. Exported cookies can grant account access. Saved session text is encrypted on the server, but encryption does not make a session safe to share. Use the app only with a correctly configured HTTPS server. Remove the saved session in Settings and revoke it from the platform if it is exposed.
          </Text>
        </View>

        <Text className="text-slate-500 text-[10px] leading-4 px-1">
          Only download content you have permission to save, and follow each platform’s terms. Public links can often be analyzed without connecting an account.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
