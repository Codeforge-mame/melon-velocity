import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadRecord, useDb } from '../context/DbContext';

export function useDownloadHistory() {
    const { getHistory } = useDb();
    return useQuery<DownloadRecord[], Error>({
        queryKey: ['downloadHistory'],
        queryFn: getHistory,
    });
}

export function useLogDownload() {
    const queryClient = useQueryClient();
    const { addDownload } = useDb();

    return useMutation({
        mutationFn: addDownload,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
        },
    });
}

export function useDeleteHistoryItem() {
    const queryClient = useQueryClient();
    const { deleteRecord } = useDb();

    return useMutation({
        mutationFn: deleteRecord,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
        },
    });
}