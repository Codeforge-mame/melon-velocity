import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
export type ConnectionType = 'wifi' | 'cellular' | 'none' | 'unknown';

export type NetworkInfo = {
  quality: NetworkQuality;
  type: ConnectionType;
  isConnected: boolean;
  isInternetReachable: boolean;
  downloadSpeed?: number; // in Mbps
  latency?: number; // in ms
  signalStrength?: number; // 0-100
};

class NetworkQualityDetector {
  private currentQuality: NetworkQuality = 'offline';
  private currentType: ConnectionType = 'none';
  private listeners = new Set<(info: NetworkInfo) => void>();

  async initialize(): Promise<void> {
    // Subscribe to network state changes
    NetInfo.addEventListener(state => {
      this.handleNetworkChange(state);
    });

    // Initial check
    const state = await NetInfo.fetch();
    this.handleNetworkChange(state);
  }

  private async handleNetworkChange(state: NetInfoState): Promise<void> {
    const info = await this.assessNetworkQuality(state);
    this.currentQuality = info.quality;
    this.currentType = info.type;
    this.notifyListeners(info);
  }

  async assessNetworkQuality(state?: any): Promise<NetworkInfo> {
    const networkState = state || await NetInfo.fetch();

    const isConnected = networkState.isConnected ?? false;
    const isInternetReachable = networkState.isInternetReachable ?? false;

    if (!isConnected || !isInternetReachable) {
      return {
        quality: 'offline',
        type: 'none',
        isConnected: false,
        isInternetReachable: false,
      };
    }

    const type = this.getConnectionType(networkState.type);
    const quality = await this.calculateQuality(type, networkState);

    return {
      quality,
      type,
      isConnected: true,
      isInternetReachable: true,
      signalStrength: networkState.strength,
    };
  }

  private getConnectionType(type: string): ConnectionType {
    if (type === 'wifi') return 'wifi';
    if (type === 'cellular') return 'cellular';
    if (type === 'none') return 'none';
    return 'unknown';
  }

  private async calculateQuality(type: ConnectionType, state: NetInfoState): Promise<NetworkQuality> {
    if (type === 'wifi') {
      // WiFi is generally good to excellent
      const details = state.type === 'wifi' ? state.details : null;
      const strength = (details as any)?.strength || 0;
      if (strength > 80) return 'excellent';
      if (strength > 60) return 'good';
      if (strength > 40) return 'fair';
      return 'poor';
    }

    if (type === 'cellular') {
      // Cellular quality depends on generation
      const details = state.type === 'cellular' ? state.details : null;
      const cellularDetails = details as any;
      const effectiveType = cellularDetails?.effectiveType;
      
      if (effectiveType === '4g' || effectiveType === 'lte') {
        return 'good';
      }
      if (effectiveType === '3g') {
        return 'fair';
      }
      if (effectiveType === '2g') {
        return 'poor';
      }
      
      // Fallback based on signal strength
      const strength = cellularDetails?.strength || 0;
      if (strength > 70) return 'good';
      if (strength > 50) return 'fair';
      return 'poor';
    }

    return 'fair';
  }

  getCurrentQuality(): NetworkQuality {
    return this.currentQuality;
  }

  async getCurrentNetworkInfo(): Promise<NetworkInfo> {
    return this.assessNetworkQuality();
  }

  subscribe(listener: (info: NetworkInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(info: NetworkInfo): void {
    this.listeners.forEach(listener => listener(info));
  }

  isGoodForDownload(): boolean {
    return this.currentQuality === 'excellent' || this.currentQuality === 'good';
  }

  isWifi(): boolean {
    return this.currentType === 'wifi';
  }

  shouldThrottleDownload(): boolean {
    return this.currentQuality === 'fair' || this.currentQuality === 'poor';
  }
}

export const networkQualityDetector = new NetworkQualityDetector();
