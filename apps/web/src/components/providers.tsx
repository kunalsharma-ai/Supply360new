'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { DEFAULT_THEME, isLight, isTheme, MOTION_KEY, THEME_KEY, type ThemeId } from '@/lib/themes';

interface ThemeState {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  /** Playful motion (tilt, floating shapes, count-ups). Always off when the OS asks for reduced motion. */
  motion: boolean;
  setMotion: (on: boolean) => void;
}
const ThemeCtx = createContext<ThemeState>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  motion: true,
  setMotion: () => {},
});
export const useTheme = () => useContext(ThemeCtx);

const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

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
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [motion, setMotionState] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (isTheme(saved)) setThemeState(saved);
      if (localStorage.getItem(MOTION_KEY) === 'off') setMotionState(false);
    } catch {
      /* storage unavailable: keep the defaults */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.mode = isLight(theme) ? 'light' : 'dark';
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? 'on' : 'off';
  }, [motion]);
  const setTheme = (t: ThemeId) => {
    setThemeState(t);
    save(THEME_KEY, t);
  };
  const setMotion = (on: boolean) => {
    setMotionState(on);
    save(MOTION_KEY, on ? 'on' : 'off');
  };
  return (
    <ThemeCtx.Provider value={{ theme, setTheme, motion, setMotion }}>
      <QueryClientProvider client={client}>
        {children}
        <Toaster theme={isLight(theme) ? 'light' : 'dark'} position="bottom-right" richColors closeButton />
      </QueryClientProvider>
    </ThemeCtx.Provider>
  );
}
