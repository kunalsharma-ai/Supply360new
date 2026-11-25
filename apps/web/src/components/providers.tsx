'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { isTheme, THEME_KEY, type ThemeId } from '@/lib/themes';

const ThemeCtx = createContext<{ theme: ThemeId; setTheme: (t: ThemeId) => void }>({
  theme: 'midnight',
  setTheme: () => {},
});
export const useTheme = () => useContext(ThemeCtx);

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
          },
        },
      }),
  );
  const [theme, setThemeState] = useState<ThemeId>('midnight');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (isTheme(saved)) setThemeState(saved);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.mode = theme === 'arctic' ? 'light' : 'dark';
  }, [theme]);
  const setTheme = (t: ThemeId) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  };
  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>
      <QueryClientProvider client={client}>
        {children}
        <Toaster theme={theme === 'arctic' ? 'light' : 'dark'} position="bottom-right" richColors closeButton />
      </QueryClientProvider>
    </ThemeCtx.Provider>
  );
}
