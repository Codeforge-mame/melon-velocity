import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFERENCES_KEY = '@app_preferences';

export type UserPreferences = {
  defaultQuality: 'auto' | 'highest' | 'lowest' | 'custom';
  customQuality?: string;
  autoSaveToGallery: boolean;
  downloadOverWifi: boolean;
  maxConcurrentDownloads: number;
  enableNotifications: boolean;
  enableAutoRetry: boolean;
  maxRetries: number;
  theme: 'light' | 'dark' | 'auto';
  language: string;
  downloadLocation: string;
  autoDeleteCompleted: boolean;
  autoDeleteAfterDays: number;
};

const DEFAULT_PREFERENCES: UserPreferences = {
  defaultQuality: 'auto',
  autoSaveToGallery: false,
  downloadOverWifi: false,
  maxConcurrentDownloads: 2,
  enableNotifications: true,
  enableAutoRetry: true,
  maxRetries: 3,
  theme: 'auto',
  language: 'en',
  downloadLocation: 'default',
  autoDeleteCompleted: false,
  autoDeleteAfterDays: 30,
};

class PreferencesManager {
  private preferences: UserPreferences = DEFAULT_PREFERENCES;
  private listeners = new Set<(prefs: UserPreferences) => void>();

  async loadPreferences(): Promise<UserPreferences> {
    try {
      const stored = await AsyncStorage.getItem(PREFERENCES_KEY);
      if (stored) {
        this.preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
      }
    } catch (error) {
      console.error('Failed to load preferences:', error);
      this.preferences = DEFAULT_PREFERENCES;
    }
    return this.preferences;
  }

  async savePreferences(): Promise<void> {
    try {
      await AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences));
      this.notifyListeners();
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  }

  getPreferences(): UserPreferences {
    return { ...this.preferences };
  }

  async updatePreference<K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ): Promise<void> {
    this.preferences[key] = value;
    await this.savePreferences();
  }

  async updatePreferences(updates: Partial<UserPreferences>): Promise<void> {
    this.preferences = { ...this.preferences, ...updates };
    await this.savePreferences();
  }

  async resetPreferences(): Promise<void> {
    this.preferences = DEFAULT_PREFERENCES;
    await this.savePreferences();
  }

  subscribe(listener: (prefs: UserPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.getPreferences()));
  }

  // Convenience getters
  get defaultQuality(): string {
    return this.preferences.defaultQuality;
  }

  get autoSaveToGallery(): boolean {
    return this.preferences.autoSaveToGallery;
  }

  get downloadOverWifi(): boolean {
    return this.preferences.downloadOverWifi;
  }

  get maxConcurrentDownloads(): number {
    return this.preferences.maxConcurrentDownloads;
  }

  get enableNotifications(): boolean {
    return this.preferences.enableNotifications;
  }

  get enableAutoRetry(): boolean {
    return this.preferences.enableAutoRetry;
  }

  get maxRetries(): number {
    return this.preferences.maxRetries;
  }

  get theme(): string {
    return this.preferences.theme;
  }

  get language(): string {
    return this.preferences.language;
  }

  get autoDeleteCompleted(): boolean {
    return this.preferences.autoDeleteCompleted;
  }

  get autoDeleteAfterDays(): number {
    return this.preferences.autoDeleteAfterDays;
  }
}

export const preferencesManager = new PreferencesManager();
