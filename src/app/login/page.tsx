'use client';
import { useState } from 'react';
import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { ShieldCheck, Sparkles } from 'lucide-react';

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
        let reason = '';
        try { reason = (await res.json())?.error || ''; } catch {}
        await signOut(auth);
        setError(
          res.status === 403
            ? `${cred.user.email} is not on the approved list. Contact your admin.`
            : `Sign-in rejected (HTTP ${res.status}${reason ? `: ${reason}` : ''}). The server couldn't verify your token — usually a missing/invalid FIREBASE_SERVICE_ACCOUNT on the server.`
        );
        setLoading(false);
        return;
      }
      const user = await res.json();
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      if (user.role === 'admin') router.push('/admin/stats');
      else router.push('/reviewer/dashboard');
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') { setLoading(false); return; }
      const hint =
        err.code === 'auth/unauthorized-domain' ? ' — this site’s domain is not in the Firebase authorized-domains list.'
        : err.code === 'auth/popup-blocked'      ? ' — the browser blocked the sign-in popup.'
        : err.code === 'auth/operation-not-allowed' ? ' — Google sign-in is not enabled for this Firebase project.'
        : '';
      setError(`Sign-in failed: ${err.code || err.message || 'unknown error'}${hint}`);
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1.5rem',
      overflow: 'hidden',
      background:
        'radial-gradient(900px 500px at 12% 8%, rgba(58,140,63,0.18), transparent 55%),' +
        'radial-gradient(800px 600px at 92% 92%, rgba(102,187,106,0.16), transparent 55%),' +
        'linear-gradient(160deg, #eef7ef 0%, #f6faf6 45%, #e9f4ea 100%)',
    }}>
      {/* Soft decorative grid */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0,
        backgroundImage:
          'linear-gradient(rgba(58,140,63,0.05) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(58,140,63,0.05) 1px, transparent 1px)',
        backgroundSize: '44px 44px',
        maskImage: 'radial-gradient(circle at 50% 45%, black, transparent 78%)',
        WebkitMaskImage: 'radial-gradient(circle at 50% 45%, black, transparent 78%)',
      }}/>

      <div className="animate-rise" style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 22,
        padding: '2.75rem 2.5rem',
        width: '100%',
        maxWidth: 416,
        boxShadow: 'var(--shadow-xl)',
        border: '1px solid rgba(58,140,63,0.14)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}>
        {/* AI pill */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--green-100)', color: 'var(--green-700)',
          padding: '4px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700,
          letterSpacing: 0.3, marginBottom: '1.5rem',
        }}>
          <Sparkles size={12}/> AI-POWERED REVIEW CONSOLE
        </div>

        {/* Logo badge */}
        <div style={{
          width: 84, height: 84, borderRadius: 22,
          background: 'linear-gradient(180deg, #ffffff, #f1f8f1)',
          border: '1px solid var(--green-200)',
          boxShadow: 'var(--shadow-md)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: '1.25rem',
        }}>
          <Image src="/logo.png" alt="AI Events Ingestion Software" width={52} height={52} priority style={{ borderRadius: 12 }}/>
        </div>

        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--green-600)', letterSpacing: 1.2 }}>
          AI EVENTS INGESTION
        </div>
        <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: '1.75rem' }}>
          CommunityHub
        </div>

        <h1 style={{ fontSize: 25, fontWeight: 800, marginBottom: 6, color: 'var(--black)' }}>
          Welcome back
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--gray-mid)', marginBottom: '1.75rem', lineHeight: 1.5 }}>
          Sign in to review and approve community events.
        </p>

        {error && (
          <div className="animate-pop" style={{
            background: 'var(--danger-light)', color: 'var(--danger-dark)',
            border: '1px solid #f5c6cb',
            padding: '0.75rem 1rem', borderRadius: 10,
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
            width: '100%', padding: '0.9rem',
            border: '1.5px solid var(--gray-300)', borderRadius: 12,
            background: 'white', cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            fontSize: 15, fontWeight: 600, color: 'var(--gray-dark)',
            transition: 'all 0.18s var(--ease)', opacity: loading ? 0.75 : 1,
            boxShadow: 'var(--shadow-xs)',
          }}
          onMouseEnter={e => { if (!loading) { e.currentTarget.style.borderColor = 'var(--green-400)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gray-300)'; e.currentTarget.style.boxShadow = 'var(--shadow-xs)'; e.currentTarget.style.transform = 'none'; }}
        >
          {loading ? (
            <span className="spinner" style={{ width: 18, height: 18 }}/>
          ) : (
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-8.9 20-20 0-1.2-.1-2.3-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19.1 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.7 39.8 16.3 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4.1 5.2l6.2 5.2C43 34.7 44 29.7 44 24c0-1.2-.1-2.3-.4-3.5z"/>
            </svg>
          )}
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, marginTop: '1.5rem',
          fontSize: 11.5, color: 'var(--gray-500)',
        }}>
          <ShieldCheck size={13} color="var(--green-500)"/>
          Access is invite-only. Contact your administrator.
        </div>
      </div>
    </div>
  );
}
