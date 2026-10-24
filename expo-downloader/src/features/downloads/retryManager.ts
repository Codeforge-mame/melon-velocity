import { getDatabase } from '../../db/database';

export type RetryConfig = {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export class RetryManager {
  private config: RetryConfig;
  private retryAttempts = new Map<string, number>();

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  async shouldRetry(downloadId: string): Promise<boolean> {
    const db = await getDatabase();
    const download = await db.getFirstAsync<any>(
      'SELECT retry_count, error_message FROM downloads WHERE id = ?',
      downloadId
    );

    if (!download) return false;
    
    const retryCount = download.retry_count || 0;
    return retryCount < this.config.maxRetries;
  }

  async incrementRetryCount(downloadId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE downloads SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP WHERE id = ?',
      downloadId
    );
  }

  async getRetryDelay(downloadId: string): Promise<number> {
    const db = await getDatabase();
    const download = await db.getFirstAsync<any>(
      'SELECT retry_count FROM downloads WHERE id = ?',
      downloadId
    );

    const retryCount = download?.retry_count || 0;
    const delay = Math.min(
      this.config.initialDelayMs * Math.pow(this.config.backoffMultiplier, retryCount),
      this.config.maxDelayMs
    );

    return delay;
  }

  async resetRetryCount(downloadId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE downloads SET retry_count = 0, last_retry_at = NULL WHERE id = ?',
      downloadId
    );
  }

  async markForRetry(downloadId: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE downloads SET status = ?, retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP WHERE id = ?',
      'queued',
      downloadId
    );
  }

  async getFailedDownloads(): Promise<any[]> {
    const db = await getDatabase();
    return db.getAllAsync<any>(
      'SELECT * FROM downloads WHERE status = ? AND (retry_count IS NULL OR retry_count < ?)',
      'failed',
      this.config.maxRetries
    );
  }

  async autoRetryFailedDownloads(): Promise<number> {
    const failedDownloads = await this.getFailedDownloads();
    let retriedCount = 0;

    for (const download of failedDownloads) {
      if (await this.shouldRetry(download.id)) {
        await this.markForRetry(download.id);
        retriedCount++;
      }
    }

    return retriedCount;
  }

  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

export const retryManager = new RetryManager();
