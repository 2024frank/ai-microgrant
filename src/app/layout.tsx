import type { Metadata, Viewport } from 'next';
import { Comfortaa, Lato } from 'next/font/google';
import './globals.css';

const lato = Lato({
  subsets: ['latin'],
  weight: ['400', '700', '900'],
  display: 'swap',
  variable: '--font-lato',
});

const comfortaa = Comfortaa({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-comfortaa',
});

export const metadata: Metadata = {
  title: {
    default: 'Community Event Intake',
    template: '%s · Event Intake',
  },
  description:
    'Source ingestion, payload validation, and human review for community publishing teams.',
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#212934',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lato.variable} ${comfortaa.variable}`}>
      <body>{children}</body>
    </html>
  );
}
