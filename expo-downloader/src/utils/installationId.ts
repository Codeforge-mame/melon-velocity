import AsyncStorage from '@react-native-async-storage/async-storage';

const INSTALLATION_ID_KEY = 'installation_id';

/**
 * Generate a random installation ID (32 alphanumeric characters)
 */
function generateInstallationId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Get or create the installation ID for this device.
 * The ID is persisted in AsyncStorage and sent with API requests for rate limiting.
 */
export async function getInstallationId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
    
    if (!id) {
      id = generateInstallationId();
      await AsyncStorage.setItem(INSTALLATION_ID_KEY, id);
    }
    
    return id;
  } catch (error) {
    console.warn('Failed to access AsyncStorage, using ephemeral ID:', error);
    // Fallback to a session-based ID if AsyncStorage fails
    return generateInstallationId();
  }
}

/**
 * Reset the installation ID (useful for testing or debugging)
 */
export async function resetInstallationId(): Promise<void> {
  try {
    await AsyncStorage.removeItem(INSTALLATION_ID_KEY);
  } catch (error) {
    console.warn('Failed to reset installation ID:', error);
  }
}
