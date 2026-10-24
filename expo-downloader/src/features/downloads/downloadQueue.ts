import { getDatabase } from "../../db/database";

export type QueuedDownload = {
  id: string;
  url: string;
  title: string;
  thumbnailUrl?: string;
  filename: string;
  formatId?: string;
  resolutionLabel?: string;
  queuePosition: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
  addedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
};

const MAX_CONCURRENT_DOWNLOADS = 2;

class DownloadQueue {
  private queue: QueuedDownload[] = [];
  private activeDownloads = new Set<string>();
  private processing = false;

  async addToQueue(download: Omit<QueuedDownload, 'queuePosition' | 'status' | 'addedAt'>): Promise<string> {
    const queuedDownload: QueuedDownload = {
      ...download,
      queuePosition: this.queue.length + 1,
      status: 'queued',
      addedAt: new Date().toISOString(),
    };

    this.queue.push(queuedDownload);

    // NOTE: The database INSERT is intentionally omitted here.
    // downloadManager.startDownload() already inserts the row before calling
    // addToQueue(), so inserting again would hit the PRIMARY KEY constraint.
    // This method only manages the in-memory queue.

    this.processQueue();
    return queuedDownload.id;
  }

  async removeFromQueue(downloadId: string): Promise<void> {
    const db = await getDatabase();
    
    // Remove from queue
    this.queue = this.queue.filter(d => d.id !== downloadId);
    this.activeDownloads.delete(downloadId);
    
    // Delete from database
    await db.runAsync('DELETE FROM downloads WHERE id = ?', downloadId);
    
    // Reorder remaining items
    this.queue.forEach((item, index) => {
      item.queuePosition = index + 1;
    });
    
    this.processQueue();
  }

  async pauseDownload(downloadId: string): Promise<void> {
    const db = await getDatabase();
    const download = this.queue.find(d => d.id === downloadId);
    
    if (download) {
      download.status = 'paused';
      this.activeDownloads.delete(downloadId);
      
      await db.runAsync('UPDATE downloads SET status = ? WHERE id = ?', 'paused', downloadId);
      
      this.processQueue();
    }
  }

  async resumeDownload(downloadId: string): Promise<void> {
    const db = await getDatabase();
    const download = this.queue.find(d => d.id === downloadId);
    
    if (download) {
      download.status = 'queued';
      
      await db.runAsync('UPDATE downloads SET status = ? WHERE id = ?', 'queued', downloadId);
      
      this.processQueue();
    }
  }

  getQueue(): QueuedDownload[] {
    return [...this.queue];
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getActiveDownloads(): string[] {
    return Array.from(this.activeDownloads);
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    
    this.processing = true;
    
    try {
      while (this.activeDownloads.size < MAX_CONCURRENT_DOWNLOADS) {
        const nextDownload = this.queue.find(
          d => d.status === 'queued' && !this.activeDownloads.has(d.id)
        );
        
        if (!nextDownload) break;
        
        this.activeDownloads.add(nextDownload.id);
        nextDownload.status = 'downloading';
        nextDownload.startedAt = new Date().toISOString();
        
        const db = await getDatabase();
        await db.runAsync(
          'UPDATE downloads SET status = ?, started_at = ? WHERE id = ?',
          'downloading',
          nextDownload.startedAt,
          nextDownload.id
        );
        
        // Trigger the actual download (this would be called by the downloadManager)
        // For now, we just mark it as downloading
      }
    } finally {
      this.processing = false;
    }
  }

  async markCompleted(downloadId: string): Promise<void> {
    const download = this.queue.find(d => d.id === downloadId);
    
    if (download) {
      download.status = 'completed';
      download.completedAt = new Date().toISOString();
      this.activeDownloads.delete(downloadId);
      
      const db = await getDatabase();
      await db.runAsync(
        'UPDATE downloads SET status = ?, completed_at = ? WHERE id = ?',
        'completed',
        download.completedAt,
        downloadId
      );
      
      this.processQueue();
    }
  }

  async markFailed(downloadId: string, error: string): Promise<void> {
    const download = this.queue.find(d => d.id === downloadId);
    
    if (download) {
      download.status = 'failed';
      download.errorMessage = error;
      this.activeDownloads.delete(downloadId);
      
      const db = await getDatabase();
      await db.runAsync(
        'UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
        'failed',
        error,
        downloadId
      );
      
      this.processQueue();
    }
  }

  clearCompleted(): void {
    this.queue = this.queue.filter(d => d.status !== 'completed');
  }
}

export const downloadQueue = new DownloadQueue();
