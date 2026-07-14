'use client';
import { useState } from 'react';

interface Step {
  title:    string;
  body:     string;
  icon:     React.ReactNode;
  tip?:     string;
}

const ADMIN_STEPS: Step[] = [
  {
    title: 'Welcome to Event Intake',
    body:  'This workspace brings source runs, incoming records, and reviewer decisions together. This tour takes about 60 seconds.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="30" fill="#e8f5e9"/>
        <path d="M20 44 C20 36 44 36 44 44" stroke="#3a8c3f" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
        <circle cx="32" cy="26" r="8" fill="#3a8c3f"/>
        <path d="M26 20 L32 14 L38 20" stroke="#3a8c3f" strokeWidth="2" strokeLinecap="round" fill="none"/>
      </svg>
    ),
  },
  {
    title: 'Stats dashboard',
    body:  'Your top-level overview. See how many events were extracted, approval rates by source, rejection reasons, and reviewer activity — all filterable by time window.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#e8f5e9"/>
        <rect x="12" y="36" width="8" height="16" rx="2" fill="#3a8c3f"/>
        <rect x="24" y="26" width="8" height="26" rx="2" fill="#3a8c3f" opacity=".7"/>
        <rect x="36" y="18" width="8" height="34" rx="2" fill="#3a8c3f" opacity=".5"/>
        <rect x="48" y="30" width="8" height="22" rx="2" fill="#3a8c3f" opacity=".3"/>
        <polyline points="12,34 28,24 36,16 52,28" stroke="#3a8c3f" strokeWidth="2" strokeLinecap="round" fill="none"/>
      </svg>
    ),
    tip: 'Find it in the sidebar under Stats',
  },
  {
    title: 'Extraction quality signals',
    body:  'Operational metrics for each source: review outcomes, run time, frequently corrected fields, and a simple grade based on observed results.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#e3f2fd"/>
        <circle cx="32" cy="28" r="12" stroke="#1565c0" strokeWidth="2.5" fill="none"/>
        <circle cx="32" cy="28" r="4" fill="#1565c0"/>
        <path d="M32 16 L32 12 M32 44 L32 40 M44 28 L48 28 M16 28 L20 28" stroke="#1565c0" strokeWidth="2" strokeLinecap="round"/>
        <rect x="18" y="44" width="28" height="6" rx="3" fill="#1565c0" opacity=".2"/>
        <rect x="18" y="44" width="18" height="6" rx="3" fill="#1565c0" opacity=".6"/>
        <text x="32" y="57" textAnchor="middle" fontSize="7" fill="#1565c0" fontWeight="700">A</text>
      </svg>
    ),
    tip: 'Find it in the sidebar under Quality signals',
  },
  {
    title: 'Review queue',
    body:  'Every incoming record lands here first. Reviewers compare source evidence, correct fields, and validate the outgoing payload. Publishing submits the record to CommunityHub immediately.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#fff8e1"/>
        <rect x="12" y="16" width="40" height="8" rx="3" fill="#e67e22" opacity=".3"/>
        <rect x="12" y="16" width="25" height="8" rx="3" fill="#e67e22" opacity=".8"/>
        <rect x="12" y="28" width="40" height="8" rx="3" fill="#e67e22" opacity=".3"/>
        <rect x="12" y="28" width="35" height="8" rx="3" fill="#e67e22" opacity=".6"/>
        <rect x="12" y="40" width="40" height="8" rx="3" fill="#e67e22" opacity=".3"/>
        <rect x="12" y="40" width="15" height="8" rx="3" fill="#e67e22" opacity=".4"/>
      </svg>
    ),
    tip: 'Find it in the sidebar under Review queue',
  },
  {
    title: 'Manage your team',
    body:  'Invite reviewers and admins from Admin Controls. Assign specific sources to reviewers so they only see what is relevant to them, or leave it open for access to everything.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#f3e5f5"/>
        <circle cx="22" cy="26" r="7" fill="#7b1fa2" opacity=".5"/>
        <circle cx="38" cy="26" r="7" fill="#7b1fa2" opacity=".8"/>
        <path d="M10 46 C10 38 34 38 34 46" stroke="#7b1fa2" strokeWidth="2.5" strokeLinecap="round" fill="none" opacity=".5"/>
        <path d="M28 46 C28 38 52 38 52 46" stroke="#7b1fa2" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
        <circle cx="50" cy="14" r="7" fill="#7b1fa2"/>
        <path d="M47 14 L49.5 16.5 L54 12" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      </svg>
    ),
    tip: 'Find it in the sidebar under Admin Controls',
  },
  {
    title: "You're all set",
    body:  "Setup status depends on your configured sources and deployment. Start in Sources & runs to confirm source health, then review any waiting records.",
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="30" fill="#e8f5e9"/>
        <path d="M20 32 L28 40 L44 24" stroke="#3a8c3f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    ),
  },
];

const REVIEWER_STEPS: Step[] = [
  {
    title: 'Welcome to Event Intake',
    body:  'Configured extractors bring records from multiple sources here for human review before publication. This tour takes about 60 seconds.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="30" fill="#e8f5e9"/>
        <path d="M20 44 C20 36 44 36 44 44" stroke="#3a8c3f" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
        <circle cx="32" cy="26" r="8" fill="#3a8c3f"/>
      </svg>
    ),
  },
  {
    title: 'The review queue',
    body:  'Every extracted record lands in the queue. You will see its title, source, date, and post kind at a glance. Open a record to inspect source context and payload readiness.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#e8f5e9"/>
        <rect x="10" y="14" width="44" height="9" rx="3" fill="#3a8c3f" opacity=".2"/>
        <rect x="10" y="14" width="30" height="9" rx="3" fill="#3a8c3f" opacity=".7"/>
        <rect x="10" y="27" width="44" height="9" rx="3" fill="#3a8c3f" opacity=".2"/>
        <rect x="10" y="27" width="40" height="9" rx="3" fill="#3a8c3f" opacity=".5"/>
        <rect x="10" y="40" width="44" height="9" rx="3" fill="#3a8c3f" opacity=".2"/>
        <rect x="10" y="40" width="20" height="9" rx="3" fill="#3a8c3f" opacity=".3"/>
      </svg>
    ),
    tip: 'Find it in the sidebar under Review queue',
  },
  {
    title: 'Approving an event',
    body:  'Correct the draft, then use the readiness checklist. The publish action remains blocked until documented payload requirements pass; publishing submits immediately to CommunityHub.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#e8f5e9"/>
        <circle cx="32" cy="32" r="16" fill="#3a8c3f"/>
        <path d="M24 32 L29.5 37.5 L40 27" stroke="white" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    ),
  },
  {
    title: 'Rejecting an event',
    body:  'If a record is wrong, spam, or irrelevant, reject it and choose a reason. Saved feedback may be included as context in later source runs; it does not retrain a model.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#fdecea"/>
        <circle cx="32" cy="32" r="16" fill="#c0392b"/>
        <path d="M26 26 L38 38 M38 26 L26 38" stroke="white" strokeWidth="2.8" strokeLinecap="round" fill="none"/>
      </svg>
    ),
  },
  {
    title: 'Sending back for correction',
    body:  'If the record is real but needs work, send a specific note to the correction workflow. It attempts a new draft and returns it to the queue for another human review.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#fff8e1"/>
        <path d="M44 20 L44 36 L20 36 L20 20 Z" stroke="#c05e00" strokeWidth="2" fill="none" rx="2"/>
        <path d="M20 20 L32 29 L44 20" stroke="#c05e00" strokeWidth="2" strokeLinecap="round" fill="none"/>
        <path d="M38 44 L44 38 L50 44" stroke="#c05e00" strokeWidth="2" strokeLinecap="round" fill="none"/>
        <path d="M14 44 C14 44 28 44 44 38" stroke="#c05e00" strokeWidth="2" strokeLinecap="round" fill="none"/>
      </svg>
    ),
    tip: 'Look for Request correction inside Review Studio',
  },
  {
    title: 'Your personal dashboard',
    body:  'Track everything you have reviewed — approvals, rejections, corrections sent, and how many of your corrections came back fixed and approved. Your stats update in real time.',
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#e3f2fd"/>
        <rect x="10" y="38" width="10" height="14" rx="2" fill="#1565c0" opacity=".4"/>
        <rect x="24" y="28" width="10" height="24" rx="2" fill="#1565c0" opacity=".6"/>
        <rect x="38" y="20" width="10" height="32" rx="2" fill="#1565c0" opacity=".8"/>
        <polyline points="15,36 29,26 43,18" stroke="#1565c0" strokeWidth="2" strokeLinecap="round" fill="none"/>
      </svg>
    ),
    tip: 'Find it in the sidebar under Overview',
  },
  {
    title: "You're ready",
    body:  "Head to the review queue and start with the oldest record. Verify the source, resolve every readiness blocker, and publish only when the payload is accurate.",
    icon: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="30" fill="#e8f5e9"/>
        <path d="M20 32 L28 40 L44 24" stroke="#3a8c3f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    ),
  },
];

interface Props {
  role:  'admin' | 'reviewer';
  token: string;
  onDone: () => void;
}

export default function OnboardingTour({ role, token, onDone }: Props) {
  const steps = role === 'admin' ? ADMIN_STEPS : REVIEWER_STEPS;
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const current = steps[step];
  const isLast  = step === steps.length - 1;

  async function finish() {
    setLeaving(true);
    await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    setTimeout(onDone, 300);
  }

  function next() {
    if (isLast) { finish(); return; }
    setStep(s => s + 1);
  }

  function back() { setStep(s => Math.max(0, s - 1)); }

  return (
    <div role="presentation" style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: leaving ? 0 : 1, transition: 'opacity .3s ease',
      backdropFilter: 'blur(3px)',
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="onboarding-title" style={{
        background: 'white', borderRadius: 16,
        width: '100%', maxWidth: 460,
        padding: '2.5rem 2.5rem 2rem',
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        position: 'relative',
      }}>

        {/* Skip */}
        <button type="button" onClick={finish} style={{
          position: 'absolute', top: 16, right: 16,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 12, color: '#bbb', fontWeight: 600,
          padding: '4px 8px', borderRadius: 6,
        }}>
          Skip tour
        </button>

        {/* Icon */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem' }}>
          {current.icon}
        </div>

        {/* Step counter */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#3a8c3f', textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center', marginBottom: 8 }}>
          Step {step + 1} of {steps.length}
        </div>

        {/* Title */}
        <h2 id="onboarding-title" style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a', textAlign: 'center', margin: '0 0 12px' }}>
          {current.title}
        </h2>

        {/* Body */}
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.7, textAlign: 'center', margin: '0 0 16px' }}>
          {current.body}
        </p>

        {/* Tip */}
        {current.tip && (
          <div style={{
            background: '#f0f7f0', borderRadius: 8,
            padding: '8px 14px', fontSize: 12, color: '#3a8c3f',
            fontWeight: 600, textAlign: 'center', marginBottom: 16,
          }}>
            {current.tip}
          </div>
        )}

        {/* Progress dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: '1.5rem' }}>
          {steps.map((_, i) => (
            <button type="button" aria-label={`Go to step ${i + 1}`} key={i} onClick={() => setStep(i)} style={{
              width: i === step ? 20 : 7, height: 7,
              borderRadius: 4, cursor: 'pointer',
              background: i === step ? '#3a8c3f' : i < step ? '#a5d6a7' : '#e0e0e0',
              transition: 'all .3s ease',
              border: 0, padding: 0,
            }}/>
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          {step > 0 && (
            <button type="button" onClick={back} style={{
              flex: 1, padding: '0.75rem', borderRadius: 8,
              border: '1.5px solid #ddd', background: 'white',
              fontSize: 14, fontWeight: 600, color: '#666', cursor: 'pointer',
            }}>
              Back
            </button>
          )}
          <button type="button" onClick={next} style={{
            flex: 2, padding: '0.75rem', borderRadius: 8,
            border: 'none', background: '#3a8c3f',
            fontSize: 14, fontWeight: 700, color: 'white', cursor: 'pointer',
          }}>
            {isLast ? 'Finish tour' : 'Next'}
          </button>
        </div>
      </section>
    </div>
  );
}
