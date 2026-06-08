'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, onIdTokenChanged } from 'firebase/auth';
import '@/lib/firebase';

export interface AppUser {
  id:    number;
  email: string;
  name:  string;
  role:  'admin' | 'reviewer';
}

export function useAuth(requiredRole?: 'admin' | 'reviewer') {
  const [user, setUser]   = useState<AppUser | null>(null);
  const [token, setToken] = useState<string>('');
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const auth = getAuth();

    // onIdTokenChanged fires on login AND whenever Firebase auto-refreshes the token
    const unsub = onIdTokenChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/login');
        return;
      }

      // Get fresh token
      const freshToken = await firebaseUser.getIdToken();
      localStorage.setItem('token', freshToken);
      setToken(freshToken);

      // Use stored user data — only fetch from DB if not cached
      const stored = localStorage.getItem('user');
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as AppUser;
          if (requiredRole && parsed.role !== requiredRole && !(requiredRole === 'reviewer' && parsed.role === 'admin')) {
            router.push('/login');
            return;
          }
          setUser(parsed);
          setReady(true);
          return;
        } catch {}
      }

      // No cached user — fetch from DB once
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${freshToken}` },
        });
        if (!res.ok) { router.push('/login'); return; }
        const userData = await res.json() as AppUser;
        if (requiredRole && userData.role !== requiredRole && !(requiredRole === 'reviewer' && userData.role === 'admin')) {
          router.push('/login');
          return;
        }
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        setReady(true);
      } catch {
        router.push('/login');
      }
    });

    return () => unsub();
  }, []); // eslint-disable-line

  // Call this before any important API request to guarantee fresh token
  async function getFreshToken(): Promise<string> {
    const auth = getAuth();
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return token;
    const fresh = await firebaseUser.getIdToken(); // use cached, refreshed automatically by onIdTokenChanged
    localStorage.setItem('token', fresh);
    setToken(fresh);
    return fresh;
  }

  return { user, token, ready, getFreshToken };
}
