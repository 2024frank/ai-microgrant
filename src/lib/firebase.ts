import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const configuredAuthDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com';
const productionAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

function authDomain(): string {
  if (typeof window === 'undefined') return configuredAuthDomain;

  try {
    const productionHost = new URL(productionAppUrl).host;
    // Only use the reverse-proxied helper on the canonical production host.
    // Preview deployments retain the Firebase Hosting domain because every
    // preview hostname would otherwise need its own OAuth redirect allowlist.
    return window.location.host === productionHost
      ? productionHost
      : configuredAuthDomain;
  } catch {
    return configuredAuthDomain;
  }
}

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY    || 'placeholder',
  authDomain:        authDomain(),
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID  || 'placeholder',
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'placeholder.appspot.com',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '000000',
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID     || '1:000000:web:000000',
  measurementId:     process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export default app;
