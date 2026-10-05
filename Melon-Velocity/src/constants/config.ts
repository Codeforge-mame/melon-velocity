import { Platform } from 'react-native';

/**
 * Backend API configuration
 * - On Android emulator, 'localhost' refers to the emulator itself, so we use 10.0.2.2.
 * - On iOS simulator and Web, 'localhost' points directly to the host machine.
 * - For physical mobile devices, replace with your development machine's LAN IP (e.g. http://192.168.1.X:8000/api/v1).
 */

const url = "https://cornaceous-abolitionary-bev.ngrok-free.dev/api/v1";
export const BACKEND_BASE_URL = Platform.select({
  android: url,
  ios: url,
  default: url,
});
