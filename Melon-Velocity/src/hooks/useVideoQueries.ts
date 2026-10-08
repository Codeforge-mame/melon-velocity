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
            queryClient.invalidateQueries({ queryKey: ['activeDownloadCount'] });
        },
    });
}

export function useUpdateDownload() {
    const queryClient = useQueryClient();
    const { updateDownload } = useDb();

    return useMutation({
        mutationFn: ({ id, update }: { id: number; update: Parameters<typeof updateDownload>[1] }) =>
            updateDownload(id, update),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
            queryClient.invalidateQueries({ queryKey: ['activeDownloadCount'] });
        },
    });
}

export function useActiveDownloadCount() {
    const { getActiveDownloadCount } = useDb();
    return useQuery<number, Error>({
        queryKey: ['activeDownloadCount'],
        queryFn: getActiveDownloadCount,
    });
}

export function useDeleteHistoryItem() {
    const queryClient = useQueryClient();
    const { deleteRecord } = useDb();

    return useMutation({
        mutationFn: deleteRecord,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
            queryClient.invalidateQueries({ queryKey: ['activeDownloadCount'] });
        },
    });
}