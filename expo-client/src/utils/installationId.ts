import AsyncStorage from "@react-native-async-storage/async-storage";

const INSTALLATION_ID_KEY = "installation_id";

const CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateInstallationId(length = 32): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return result;
}

let cached: string | null = null;

/**
 * Get or create a stable installation ID for this device.
 * Sent as the X-Installation-ID header for server-side rate limiting.
 */
export async function getInstallationId(): Promise<string> {
  if (cached) return cached;

  try {
    let id = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
    if (!id) {
      id = generateInstallationId();
      await AsyncStorage.setItem(INSTALLATION_ID_KEY, id);
    }
    cached = id;
    return id;
  } catch {
    cached = generateInstallationId();
    return cached;
  }
}
