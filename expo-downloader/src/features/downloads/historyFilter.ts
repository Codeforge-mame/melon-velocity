import { getDatabase } from '../../db/database';

export type FilterOptions = {
  searchQuery?: string;
  status?: 'all' | 'downloading' | 'completed' | 'failed' | 'paused';
  sortBy?: 'date' | 'title' | 'size';
  sortOrder?: 'asc' | 'desc';
  dateFrom?: string;
  dateTo?: string;
};

export async function filterHistory(filters: FilterOptions) {
  const db = await getDatabase();
  
  let query = 'SELECT * FROM downloads WHERE 1=1';
  const params: any[] = [];
  
  // Search query
  if (filters.searchQuery && filters.searchQuery.trim()) {
    query += ' AND (title LIKE ? OR url LIKE ?)';
    const searchTerm = `%${filters.searchQuery.trim()}%`;
    params.push(searchTerm, searchTerm);
  }
  
  // Status filter
  if (filters.status && filters.status !== 'all') {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  
  // Date range filter
  if (filters.dateFrom) {
    query += ' AND created_at >= ?';
    params.push(filters.dateFrom);
  }
  
  if (filters.dateTo) {
    query += ' AND created_at <= ?';
    params.push(filters.dateTo);
  }
  
  // Sorting
  const sortColumn = filters.sortBy === 'title' ? 'title' : 
                     filters.sortBy === 'size' ? 'total_bytes' : 
                     'created_at';
  const sortDirection = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
  query += ` ORDER BY ${sortColumn} ${sortDirection}`;
  
  const results = await db.getAllAsync<any>(query, ...params);
  
  return results;
}

export async function getHistoryStats() {
  const db = await getDatabase();
  
  const total = await db.getFirstAsync<any>('SELECT COUNT(*) as count FROM downloads');
  const downloading = await db.getFirstAsync<any>('SELECT COUNT(*) as count FROM downloads WHERE status = ?', 'downloading');
  const completed = await db.getFirstAsync<any>('SELECT COUNT(*) as count FROM downloads WHERE status = ?', 'completed');
  const failed = await db.getFirstAsync<any>('SELECT COUNT(*) as count FROM downloads WHERE status = ?', 'failed');
  const paused = await db.getFirstAsync<any>('SELECT COUNT(*) as count FROM downloads WHERE status = ?', 'paused');
  
  // Get total size
  const sizeResult = await db.getFirstAsync<any>('SELECT SUM(total_bytes) as total FROM downloads WHERE total_bytes IS NOT NULL');
  const totalSize = sizeResult?.total || 0;
  
  return {
    total: total?.count || 0,
    downloading: downloading?.count || 0,
    completed: completed?.count || 0,
    failed: failed?.count || 0,
    paused: paused?.count || 0,
    totalSize,
  };
}

export async function searchHistory(query: string) {
  return filterHistory({ searchQuery: query });
}

export async function filterByStatus(status: 'downloading' | 'completed' | 'failed' | 'paused') {
  return filterHistory({ status });
}

export async function getRecentDownloads(limit: number = 10) {
  const db = await getDatabase();
  return db.getAllAsync<any>(
    'SELECT * FROM downloads ORDER BY created_at DESC LIMIT ?',
    limit
  );
}

export async function getDownloadsByDateRange(startDate: string, endDate: string) {
  return filterHistory({ dateFrom: startDate, dateTo: endDate });
}
