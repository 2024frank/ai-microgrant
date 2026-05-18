'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, getAuth } from 'firebase/auth';
import '@/lib/firebase'; // ensure firebase is initialized

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

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        // Not signed in — redirect to login
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/login');
        return;
      }

      try {
        // Always get a fresh token — Firebase auto-refreshes if expired
        const freshToken = await firebaseUser.getIdToken(false);

        // Verify against our DB and get role
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${freshToken}` },
        });

        if (!res.ok) {
          router.push('/login');
          return;
        }

        const userData = await res.json() as AppUser;

        if (requiredRole && userData.role !== requiredRole && !(requiredRole === 'reviewer' && userData.role === 'admin')) {
          router.push('/login');
          return;
        }

        // Store fresh token and user
        localStorage.setItem('token', freshToken);
        localStorage.setItem('user', JSON.stringify(userData));

        setToken(freshToken);
        setUser(userData);
        setReady(true);
      } catch {
        router.push('/login');
      }
    });

    return () => unsub();
  }, []); // eslint-disable-line

  // Helper to get a guaranteed fresh token for API calls
  async function getFreshToken(): Promise<string> {
    const auth = getAuth();
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return token;
    try {
      const fresh = await firebaseUser.getIdToken(false);
      setToken(fresh);
      localStorage.setItem('token', fresh);
      return fresh;
    } catch {
      return token;
    }
  }

  return { user, token, ready, getFreshToken };
}
