'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { Check, ClipboardCheck, LockKeyhole, ShieldCheck } from 'lucide-react';
import { auth } from '@/lib/firebase';
import styles from './login.module.css';

const provider = new GoogleAuthProvider();

const WORKFLOW = [
  'Check each record against its original source.',
  'Correct required CommunityHub payload fields.',
  'Publish only after every validation check passes.',
] as const;

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleGoogleLogin() {
    setLoading(true);
    setError('');
    try {
      const credential = await signInWithPopup(auth, provider);
      const token = await credential.user.getIdToken();
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        await signOut(auth);
        setError(
          response.status === 403
            ? 'This Google account is not approved for the event intake workspace. Contact your administrator.'
            : 'We could not verify your sign-in. Contact your administrator if the problem continues.',
        );
        setLoading(false);
        return;
      }

      const user = await response.json();
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      router.push(user.role === 'admin' ? '/admin/stats' : '/reviewer/dashboard');
    } catch (caught: unknown) {
      const code = caught && typeof caught === 'object' && 'code' in caught
        ? String((caught as { code?: unknown }).code || '')
        : '';
      if (code === 'auth/popup-closed-by-user') {
        setLoading(false);
        return;
      }
      setError(
        code === 'auth/popup-blocked'
          ? 'Your browser blocked the Google sign-in window. Allow popups for this site and try again.'
          : 'Sign-in did not complete. Try again or contact your administrator.',
      );
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <Image src="/logo.png" alt="" width={34} height={34} priority />
          </span>
          <span className={styles.brandCopy}>
            <strong>Event Intake</strong>
            <span>CommunityHub · Oberlin</span>
          </span>
        </div>
        <div className={styles.workspaceStatus}>
          <span aria-hidden="true" />
          Internal publishing workspace
        </div>
      </header>

      <div className={styles.content}>
        <section className={styles.introduction} aria-labelledby="workspace-heading">
          <p className={styles.eyebrow}>Publishing operations</p>
          <h1 id="workspace-heading">Community event intake</h1>
          <p className={styles.lead}>
            Review source submissions, correct required fields, and publish approved events to the Oberlin community calendar.
          </p>

          <div className={styles.workflow} aria-label="Review workflow">
            <div className={styles.workflowHeading}>
              <ClipboardCheck size={18} aria-hidden="true" />
              <span>Standard review</span>
            </div>
            <ol>
              {WORKFLOW.map(item => (
                <li key={item}>
                  <span className={styles.check} aria-hidden="true"><Check size={13} /></span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </div>

          <p className={styles.accessNote}>
            <ShieldCheck size={17} aria-hidden="true" />
            Access is limited to approved reviewers and administrators.
          </p>
        </section>

        <section className={styles.signInPanel} aria-labelledby="sign-in-heading">
          <div className={styles.panelIcon} aria-hidden="true"><LockKeyhole size={20} /></div>
          <div className={styles.panelHeading}>
            <p>Authorized access</p>
            <h2 id="sign-in-heading">Staff sign in</h2>
            <span>Use your approved Google account.</span>
          </div>

          {error && (
            <div className={styles.error} role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          <button
            type="button"
            className={styles.googleButton}
            onClick={handleGoogleLogin}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <svg aria-hidden="true" width="19" height="19" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-8.9 20-20 0-1.2-.1-2.3-.4-3.5z" />
                <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 16 19.1 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.8 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.7 39.8 16.3 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4.1 5.2l6.2 5.2C43 34.7 44 29.7 44 24c0-1.2-.1-2.3-.4-3.5z" />
              </svg>
            )}
            <span>{loading ? 'Signing in…' : 'Continue with Google'}</span>
          </button>

          <p className={styles.helpText}>
            Need access? Contact your CommunityHub administrator.
          </p>
        </section>
      </div>

      <footer className={styles.footer}>
        <span>Oberlin community calendar operations</span>
        <span>Source review · Payload validation · Publishing</span>
      </footer>
    </main>
  );
}
