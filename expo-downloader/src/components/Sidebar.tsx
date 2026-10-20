import React from "react";
import {
    Modal,
    Pressable,
    Text,
    View,
    Animated,
    Dimensions,
} from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type SidebarProps = {
    isOpen: boolean;
    onClose: () => void;
};

const { width } = Dimensions.get("window");
const SIDEBAR_WIDTH = width * 0.75;

export function Sidebar({ isOpen, onClose }: SidebarProps) {
    const router = useRouter();
    const pathname = usePathname();
    const insets = useSafeAreaInsets();
    const slideAnim = React.useRef(new Animated.Value(-SIDEBAR_WIDTH)).current;

    React.useEffect(() => {
        Animated.timing(slideAnim, {
            toValue: isOpen ? 0 : -SIDEBAR_WIDTH,
            duration: 300,
            useNativeDriver: true,
        }).start();
    }, [isOpen]);

    const navigateTo = (path: string) => {
        onClose();
        if (pathname !== path) {
            router.push(path as any);
        }
    };

    const MenuItem = ({
        label,
        path,
        icon
    }: {
        label: string;
        path: string;
        icon: string
    }) => {
        const isActive = pathname === path;
        return (
            <Pressable
                onPress={() => navigateTo(path)}
                className={`mb-2 flex-row items-center rounded-xl p-4 ${isActive ? "bg-indigo-600" : "bg-transparent"
                    }`}
            >
                <Text className={`text-2xl ${isActive ? "text-white" : "text-slate-400"}`}>
                    {icon}
                </Text>
                <Text
                    className={`ml-4 text-lg font-semibold ${isActive ? "text-white" : "text-slate-400"
                        }`}
                >
                    {label}
                </Text>
            </Pressable>
        );
    };

    return (
        <Modal
            transparent
            visible={isOpen}
            animationType="none"
            onRequestClose={onClose}
        >
            <View className="flex-1 flex-row">
                <Animated.View
                    style={{
                        width: SIDEBAR_WIDTH,
                        transform: [{ translateX: slideAnim }],
                        paddingTop: insets.top + 20,
                        paddingBottom: insets.bottom + 20,
                    }}
                    className="h-full bg-slate-900 border-r border-slate-800 p-4"
                >
                    <View className="mb-10 px-2">
                        <Text className="text-3xl font-bold text-white">Downstream</Text>
                        <Text className="text-slate-500 mt-1">Video Downloader</Text>
                    </View>

                    <MenuItem
                        label="Home"
                        path="/"
                        icon="🏠"
                    />
                    <MenuItem
                        label="History"
                        path="/history"
                        icon="📜"
                    />

                    <View className="mt-auto border-t border-slate-800 pt-6">
                        <Text className="text-center text-slate-600 text-sm">
                            Version 1.0.0
                        </Text>
                    </View>
                </Animated.View>

                <Pressable className="flex-1 bg-black/50" onPress={onClose} />
            </View>
        </Modal>
    );
}
