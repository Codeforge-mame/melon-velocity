import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { DbProvider } from '../context/DbContext';
import { AuthProvider } from '../context/AuthContext';
import '../global.css'; // Ensure your NativeWind tailwind file is imported here

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <DbProvider>
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </AuthProvider>
      </DbProvider>
    </QueryClientProvider>
  );
}