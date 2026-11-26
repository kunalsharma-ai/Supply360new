import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Supply360', template: '%s · Supply360' },
  description: 'Human sample supply and fieldwork automation',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Render per request so Next can stamp the CSP nonce from src/proxy.ts on its scripts.
  await connection();
  return (
    <html
      lang="en"
      data-theme="glass"
      data-mode="dark"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
