export type QualityPreset = {
  id: string;
  name: string;
  description: string;
  maxHeight?: number;
  minHeight?: number;
  maxFilesize?: number;
  category?: 'video' | 'video-only' | 'audio-only';
  icon?: string;
};

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'Best quality for your network',
    icon: 'auto',
  },
  {
    id: 'highest',
    name: 'Highest Quality',
    description: 'Maximum resolution available',
    minHeight: 1080,
    category: 'video',
    icon: 'hd',
  },
  {
    id: 'high',
    name: 'High Quality (720p+)',
    description: 'Good balance of quality and size',
    minHeight: 720,
    maxHeight: 1080,
    category: 'video',
    icon: 'high-quality',
  },
  {
    id: 'medium',
    name: 'Medium Quality (480p)',
    description: 'Smaller file size, decent quality',
    minHeight: 480,
    maxHeight: 720,
    category: 'video',
    icon: 'medium-quality',
  },
  {
    id: 'low',
    name: 'Low Quality (360p)',
    description: 'Smallest file size',
    minHeight: 360,
    maxHeight: 480,
    category: 'video',
    icon: 'low-quality',
  },
  {
    id: 'audio-only',
    name: 'Audio Only',
    description: 'Download audio track only',
    category: 'audio-only',
    icon: 'music',
  },
  {
    id: 'video-only',
    name: 'Video Only',
    description: 'Download video without audio',
    category: 'video-only',
    icon: 'video',
  },
];

class QualityPresetsManager {
  private customPresets: QualityPreset[] = [];
  private selectedPresetId = 'auto';

  getPresets(): QualityPreset[] {
    return [...QUALITY_PRESETS, ...this.customPresets];
  }

  getPresetById(id: string): QualityPreset | undefined {
    return this.getPresets().find(p => p.id === id);
  }

  getSelectedPreset(): QualityPreset {
    return this.getPresetById(this.selectedPresetId) || QUALITY_PRESETS[0];
  }

  selectPreset(id: string): void {
    if (this.getPresetById(id)) {
      this.selectedPresetId = id;
    }
  }

  addCustomPreset(preset: Omit<QualityPreset, 'id'>): QualityPreset {
    const newPreset: QualityPreset = {
      ...preset,
      id: `custom-${Date.now()}`,
    };
    this.customPresets.push(newPreset);
    return newPreset;
  }

  removeCustomPreset(id: string): void {
    this.customPresets = this.customPresets.filter(p => p.id !== id);
    if (this.selectedPresetId === id) {
      this.selectedPresetId = 'auto';
    }
  }

  getFilterParams(presetId?: string): {
    min_height?: number;
    max_height?: number;
    category?: string;
  } {
    const preset = this.getPresetById(presetId || this.selectedPresetId);
    
    if (!preset || preset.id === 'auto') {
      return {};
    }

    return {
      min_height: preset.minHeight,
      max_height: preset.maxHeight,
      category: preset.category,
    };
  }

  getPresetForNetwork(networkQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline'): QualityPreset {
    if (networkQuality === 'excellent') {
      return this.getPresetById('highest') || QUALITY_PRESETS[0];
    }
    if (networkQuality === 'good') {
      return this.getPresetById('high') || QUALITY_PRESETS[0];
    }
    if (networkQuality === 'fair') {
      return this.getPresetById('medium') || QUALITY_PRESETS[0];
    }
    if (networkQuality === 'poor') {
      return this.getPresetById('low') || QUALITY_PRESETS[0];
    }
    return QUALITY_PRESETS[0]; // auto
  }

  resetToDefault(): void {
    this.selectedPresetId = 'auto';
    this.customPresets = [];
  }
}

export const qualityPresetsManager = new QualityPresetsManager();
