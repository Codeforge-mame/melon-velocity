import * as FileSystem from 'expo-file-system/legacy';

interface DownloadProgressCallback {
    (progress: {
        progressPercent: number;
        downloadSpeedMBs: number;
        bytesDownloaded: number;
        totalBytes: number;
    }): void;
}

interface DownloadParams {
    videoUrl: string;
    fileName: string;
    onProgress: DownloadProgressCallback;
}

export async function executeDownload({ videoUrl, fileName, onProgress }: DownloadParams): Promise<string | null> {
    const destinationDirectory = `${FileSystem.documentDirectory}downloads/`;
    const finalFilePath = `${destinationDirectory}${Date.now()}_${fileName}`;

    // 1. Ensure target storage directory exists natively
    const dirInfo = await FileSystem.getInfoAsync(destinationDirectory);
    if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(destinationDirectory, { intermediates: true });
    }

    const downloadStartTime = Date.now();

    // 2. Delegate download directly to native background streaming layer
    const downloadResumable = FileSystem.createDownloadResumable(
        videoUrl,
        finalFilePath,
        {
            headers: {
                'Connection': 'keep-alive'
            }
        },
        (progress) => {
            const bytes = progress.totalBytesWritten;
            const total = progress.totalBytesExpectedToWrite;

            // Calculate real-time throughput metrics safely
            const elapsed = (Date.now() - downloadStartTime) / 1000;
            const speed = elapsed > 0 ? (bytes / (1024 * 1024)) / elapsed : 0;

            onProgress({
                progressPercent: total > 0 ? Math.min((bytes / total) * 100, 100) : 0,
                downloadSpeedMBs: speed,
                bytesDownloaded: bytes,
                totalBytes: total
            });
        }
    );

    const result = await downloadResumable.downloadAsync();
    return result?.uri || null;
}