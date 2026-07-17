'use client';
import { useCallback, useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { UserPlus, Shield, Eye, Check, X, Trash2 } from 'lucide-react';

export default function AdminControlsPage() {
  const { user, token, ready } = useAuth('admin');
  const [users, setUsers]     = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({
    email: '',
    full_name: '',
    role: 'reviewer',
    source_ids: [] as number[],
    can_review_all_sources: false,
  });
  const [adding, setAdding]   = useState(false);
  const [error, setError]     = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);
  const [toast, setToast]     = useState('');

  const load = useCallback(() => {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/users',   { headers: h }).then(r => r.json()),
      fetch('/api/sources', { headers: h }).then(r => r.json()),
    ]).then(([u, s]) => { setUsers(Array.isArray(u) ? u : []); setSources(Array.isArray(s) ? s : []); }).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { if (ready && token) load(); }, [ready, token, load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  async function updateUser(id: number, changes: any) {
    setSavingId(id);
    const res = await fetch(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(changes),
    });
    if (res.ok) { load(); showToast('User updated'); }
    else showToast('Update failed');
    setSavingId(null);
  }

  async function changeRole(target: any, nextRole: 'admin' | 'reviewer') {
    if (target.role === nextRole) return;
    if (nextRole === 'reviewer') {
      const confirmed = window.confirm(
        `Demote ${target.full_name} to reviewer and explicitly grant access to all current and future sources? Cancel if they should have a narrower source assignment.`,
      );
      if (!confirmed) return;
      await updateUser(target.id, {
        role: 'reviewer',
        can_review_all_sources: true,
        source_ids: [],
      });
      return;
    }
    await updateUser(target.id, { role: 'admin' });
  }

  async function deleteUser(u: any) {
    if (!confirm(`Delete ${u.full_name} (${u.email})? This cannot be undone.`)) return;
    await fetch(`/api/users/${u.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    load();
    showToast(`${u.full_name} deleted`);
  }

  async function invite() {
    setAdding(true); setError('');
    const res = await fetch('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed'); setAdding(false); return; }
    setShowAdd(false);
    setForm({ email: '', full_name: '', role: 'reviewer', source_ids: [], can_review_all_sources: false });
    load();
    showToast(`${form.full_name} invited — welcome email sent`);
    setAdding(false);
  }

  function toggleSource(id: number) {
    setForm(f => ({
      ...f,
      can_review_all_sources: false,
      source_ids: f.source_ids.includes(id) ? f.source_ids.filter(s => s !== id) : [...f.source_ids, id],
    }));
  }

  if (!ready || !user) return null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token}/>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: '#3a8c3f', color: 'white', padding: '0.75rem 1.25rem', borderRadius: 8, fontSize: 13, fontWeight: 500, zIndex: 999, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
          {toast}
        </div>
      )}

      <main style={{ flex: 1, padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>Admin Controls</h1>
            <p style={{ fontSize: 13, color: '#888' }}>Manage users, roles, and access</p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <UserPlus size={15}/> Invite user
          </button>
        </div>

        {loading ? <div style={{ color: '#888', fontSize: 14 }}>Loading…</div> : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa', borderBottom: '1px solid #eee' }}>
                  {['User', 'Email', 'Role', 'Assigned sources', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u: any) => {
                  const isYou    = u.email === user.email;
                  const assigned = (() => { try { return JSON.parse(u.assigned_sources || '[]').filter((s: any) => s?.id); } catch { return []; } })();
                  const isSaving = savingId === u.id;

                  return (
                    <tr key={u.id} style={{ borderBottom: '1px solid #f0f0f0', background: isYou ? '#f8fff8' : 'white' }}>
                      <td style={{ padding: '0.875rem 1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', background: u.role === 'admin' ? '#3a8c3f' : '#e8f5e9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: u.role === 'admin' ? 'white' : '#3a8c3f' }}>
                            {u.full_name?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span style={{ fontWeight: 600 }}>
                            {u.full_name}
                            {isYou && <span style={{ fontSize: 10, color: '#aaa', marginLeft: 4, fontWeight: 400 }}>(you)</span>}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '0.875rem 1rem', color: '#666' }}>{u.email}</td>

                      {/* Role — inline switcher */}
                      <td style={{ padding: '0.875rem 1rem' }}>
                        {isYou ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: '#e8f5e9', color: '#2a6b2e' }}>
                            <Shield size={10}/> {u.role}
                          </span>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            {['reviewer', 'admin'].map(r => (
                              <button key={r}
                                onClick={() => !isSaving && u.role !== r && changeRole(
                                  u,
                                  r as 'admin' | 'reviewer',
                                )}
                                style={{
                                  padding: '3px 10px', borderRadius: 20, border: '1.5px solid',
                                  fontSize: 11, fontWeight: 600, cursor: isSaving || u.role === r ? 'default' : 'pointer',
                                  borderColor: u.role === r ? '#3a8c3f' : '#e0e0e0',
                                  background:  u.role === r ? '#e8f5e9' : 'white',
                                  color:       u.role === r ? '#2a6b2e' : '#aaa',
                                  display: 'flex', alignItems: 'center', gap: 3,
                                  opacity: isSaving ? 0.6 : 1,
                                }}>
                                {r === 'admin' ? <Shield size={9}/> : <Eye size={9}/>} {r}
                                {u.role === r && <Check size={9}/>}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>

                      <td style={{ padding: '0.875rem 1rem', fontSize: 12, color: '#666' }}>
                        {u.role === 'admin' || Number(u.can_review_all_sources) === 1
                          ? 'All sources'
                          : assigned.length > 0
                          ? assigned.map((s: any) => s.name).join(', ')
                          : <span style={{ color: '#c0392b' }}>No source access</span>}
                      </td>

                      <td style={{ padding: '0.875rem 1rem' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: u.active ? '#3a8c3f' : '#c0392b' }}>
                          {u.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>

                      <td style={{ padding: '0.875rem 1rem' }}>
                        {!isYou && (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <button onClick={() => updateUser(u.id, { active: u.active ? 0 : 1 })}
                              disabled={isSaving}
                              style={{ background: 'none', border: '1.5px solid #ddd', borderRadius: 6, padding: '0.3rem 0.75rem', fontSize: 12, cursor: 'pointer', color: '#666', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                              {isSaving ? '…' : u.active ? <><X size={10}/> Disable</> : <><Check size={10}/> Enable</>}
                            </button>
                            <button onClick={() => deleteUser(u)}
                              style={{ background: '#fef2f2', border: '1.5px solid #fca5a5', borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: 12, cursor: 'pointer', color: '#c0392b', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                              onMouseEnter={e => { e.currentTarget.style.background = '#fdecea'; e.currentTarget.style.borderColor = '#c0392b'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.borderColor = '#fca5a5'; }}>
                              <Trash2 size={13}/> Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!users.length && (
                  <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: '#aaa' }}>No users yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Invite modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'white', borderRadius: 12, padding: '1.75rem', width: '100%', maxWidth: 440 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Invite user</h2>
            <p style={{ fontSize: 13, color: '#888', marginBottom: '1.25rem' }}>
              They&apos;ll sign in with their Google account. A welcome email is sent immediately.
            </p>
            {error && <div style={{ background: '#fdecea', color: '#c0392b', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: 12, marginBottom: '1rem' }}>{error}</div>}

            <label style={labelStyle}>Full name</label>
            <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
              placeholder="Jane Smith" style={{ ...inputStyle, marginBottom: '1rem' }}/>

            <label style={labelStyle}>Google email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="jane@oberlin.edu" style={{ ...inputStyle, marginBottom: '1rem' }}/>

            <label style={labelStyle}>Role</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
              {['reviewer', 'admin'].map(r => (
                <button key={r} onClick={() => setForm(f => ({
                  ...f,
                  role: r,
                  source_ids: r === 'admin' ? [] : f.source_ids,
                  can_review_all_sources: r === 'admin' ? false : f.can_review_all_sources,
                }))}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 6, border: '1.5px solid', fontSize: 13, cursor: 'pointer', fontWeight: form.role === r ? 600 : 400, borderColor: form.role === r ? '#3a8c3f' : '#ddd', background: form.role === r ? '#e8f5e9' : 'white', color: form.role === r ? '#2a6b2e' : '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  {r === 'admin' ? <Shield size={13}/> : <Eye size={13}/>} {r}
                </button>
              ))}
            </div>

            {form.role === 'reviewer' && sources.length > 0 && (
              <>
                <label style={labelStyle}>Source access</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '0.45rem', borderRadius: 4, marginBottom: 6, background: form.can_review_all_sources ? '#e8f5e9' : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={form.can_review_all_sources}
                    onChange={event => setForm(f => ({
                      ...f,
                      can_review_all_sources: event.target.checked,
                      source_ids: event.target.checked ? [] : f.source_ids,
                    }))}
                  />
                  All current and future sources
                </label>
                <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>Or choose one or more specific sources:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: '1rem', maxHeight: 140, overflowY: 'auto', border: '1.5px solid #ddd', borderRadius: 6, padding: '0.5rem' }}>
                  {sources.map(s => (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '0.25rem 0.4rem', borderRadius: 4, background: form.source_ids.includes(s.id) ? '#e8f5e9' : 'transparent' }}>
                      <input type="checkbox" checked={form.source_ids.includes(s.id)} onChange={() => toggleSource(s.id)}/> {s.name}
                    </label>
                  ))}
                </div>
              </>
            )}

            <div style={{ background: '#e8f5e9', borderRadius: 6, padding: '0.6rem 0.75rem', fontSize: 12, color: '#2a6b2e', marginBottom: '1.25rem' }}>
              📧 Welcome email sent immediately on invite
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setError(''); }} className="btn-ghost" style={{ fontSize: 13 }}>Cancel</button>
              <button
                onClick={invite}
                disabled={
                  !form.email
                  || !form.full_name
                  || adding
                  || (form.role === 'reviewer' && !form.can_review_all_sources && form.source_ids.length === 0)
                }
                className="btn-primary"
                style={{ fontSize: 13 }}
              >
                {adding ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: '100%', padding: '0.6rem 0.75rem', border: '1.5px solid #ddd', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
