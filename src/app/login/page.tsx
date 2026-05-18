'use client';
import { useState } from 'react';
import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

const provider = new GoogleAuthProvider();

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const router = useRouter();

  async function handleGoogleLogin() {
    setLoading(true); setError('');
    try {
      const cred  = await signInWithPopup(auth, provider);
      const token = await cred.user.getIdToken();
      const res   = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        await signOut(auth);
        setError(`${cred.user.email} is not authorized. Contact your admin.`);
        setLoading(false);
        return;
      }
      const user = await res.json();
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      if (user.role === 'admin') router.push('/admin/stats');
      else router.push('/reviewer/dashboard');
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') setError('Sign-in failed. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(160deg, #e8f5e9 0%, #f0f7f0 50%, #e8f5e9 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
    }}>
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: '3rem 2.5rem',
        width: '100%',
        maxWidth: 400,
        boxShadow: '0 8px 40px rgba(58,140,63,0.12)',
        border: '1px solid #d8edd8',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}>
        {/* Centered logo */}
        <div style={{ marginBottom: '1.25rem' }}>
          <Image
            src="/logo.png"
            alt="AI Events Aggregator"
            width={80}
            height={80}
            priority
          />
        </div>

        <div style={{ fontSize: 20, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.5, marginBottom: 2 }}>
          AI EVENTS AGGREGATOR
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: '2rem' }}>
          CommunityHub
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: '1.75rem', color: '#111' }}>
          Welcome
        </h1>

        {error && (
          <div style={{
            background: '#fdecea', color: '#c0392b',
            border: '1px solid #f5c6cb',
            padding: '0.75rem 1rem', borderRadius: 8,
            fontSize: 13, marginBottom: '1.25rem',
            lineHeight: 1.5, width: '100%', boxSizing: 'border-box',
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          style={{
            width: '100%', padding: '0.875rem',
            border: '1.5px solid #ddd', borderRadius: 10,
            background: 'white', cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            fontSize: 15, fontWeight: 600, color: '#333',
            transition: 'all 0.15s', opacity: loading ? 0.7 : 1,
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
          onMouseEnter={e => { if (!loading) { e.currentTarget.style.borderColor = '#3a8c3f'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(58,140,63,0.15)'; }}}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.06)'; }}
        >
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-8.9 20-20 0-1.2-.1-2.3-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19.1 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.7 39.8 16.3 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4.1 5.2l6.2 5.2C43 34.7 44 29.7 44 24c0-1.2-.1-2.3-.4-3.5z"/>
          </svg>
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>

        <p style={{ fontSize: 11, color: '#ccc', marginTop: '1.5rem' }}>
          Don&apos;t have access? Contact your administrator.
        </p>
      </div>
    </div>
  );
}
