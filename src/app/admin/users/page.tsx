'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { UserPlus, Shield, Eye, Trash2 } from 'lucide-react';

export default function UsersPage() {
  const { user, token, ready } = useAuth('admin');
  const [users, setUsers]     = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ email:'', full_name:'', role:'reviewer', source_ids:[] as number[] });
  const [adding, setAdding]   = useState(false);
  const [error, setError]     = useState('');

  function load() {
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/users',   { headers: h }).then(r=>r.json()),
      fetch('/api/sources', { headers: h }).then(r=>r.json()),
    ]).then(([u,s]) => { setUsers(u); setSources(s); }).finally(()=>setLoading(false));
  }
  useEffect(() => { if (ready && token) load(); }, [ready, token]);

  async function invite() {
    setAdding(true); setError('');
    const res = await fetch('/api/users/invite', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error||'Failed'); setAdding(false); return; }
    setShowAdd(false); setForm({ email:'', full_name:'', role:'reviewer', source_ids:[] }); load(); setAdding(false);
  }

  async function toggleActive(u: any) {
    await fetch(`/api/users/${u.id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      body: JSON.stringify({ active: u.active?0:1 }),
    });
    load();
  }

  async function deleteUser(u: any) {
    if (!confirm(`Delete ${u.full_name} (${u.email})? This cannot be undone.`)) return;
    await fetch(`/api/users/${u.id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } });
    load();
  }

  function toggleSource(id: number) {
    setForm(f => ({ ...f, source_ids: f.source_ids.includes(id) ? f.source_ids.filter(s=>s!==id) : [...f.source_ids, id] }));
  }

  if (!ready || !user) return null;

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:'#f8f9fa' }}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token} />
      <main style={{ flex:1, padding:'2rem' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1.5rem' }}>
          <div>
            <h1 style={{ fontSize:22, fontWeight:700, marginBottom:2 }}>Users</h1>
            <p style={{ fontSize:13, color:'#888' }}>Only approved users can sign in with Google</p>
          </div>
          <button onClick={()=>setShowAdd(true)} className="btn-primary" style={{ display:'flex', alignItems:'center', gap:6, fontSize:13 }}>
            <UserPlus size={15}/> Invite user
          </button>
        </div>

        {loading ? <div style={{ color:'#888', fontSize:14 }}>Loading…</div> : (
          <div className="card" style={{ padding:0, overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f8f9fa', borderBottom:'1px solid #eee' }}>
                  {['Name','Email','Role','Assigned sources','Status',''].map(h=>(
                    <th key={h} style={{ padding:'0.75rem 1rem', textAlign:'left', fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u:any) => {
                  const assigned = (() => { try { return JSON.parse(u.assigned_sources||'[]').filter((s:any)=>s?.id); } catch { return []; } })();
                  const isYou = u.email === user.email;
                  return (
                    <tr key={u.id} style={{ borderBottom:'1px solid #f0f0f0', background: isYou?'#f8fff8':'transparent' }}>
                      <td style={{ padding:'0.875rem 1rem' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:30, height:30, borderRadius:'50%', background:'#e8f5e9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700, color:'#3a8c3f' }}>
                            {u.full_name?.[0]?.toUpperCase()||'?'}
                          </div>
                          <span style={{ fontWeight:600 }}>{u.full_name}{isYou && <span style={{ fontSize:10, color:'#aaa', marginLeft:4 }}>(you)</span>}</span>
                        </div>
                      </td>
                      <td style={{ padding:'0.875rem 1rem', color:'#666' }}>{u.email}</td>
                      <td style={{ padding:'0.875rem 1rem' }}>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:u.role==='admin'?'#e8f5e9':'#f0f0f0', color:u.role==='admin'?'#2a6b2e':'#555' }}>
                          {u.role==='admin'?<Shield size={10}/>:<Eye size={10}/>} {u.role}
                        </span>
                      </td>
                      <td style={{ padding:'0.875rem 1rem', fontSize:12, color:'#666' }}>
                        {assigned.length>0 ? assigned.map((s:any)=>s.name).join(', ') : <span style={{ color:'#bbb' }}>All sources</span>}
                      </td>
                      <td style={{ padding:'0.875rem 1rem' }}>
                        <span style={{ fontSize:11, fontWeight:600, color:u.active?'#3a8c3f':'#c0392b' }}>{u.active?'Active':'Disabled'}</span>
                      </td>
                      <td style={{ padding:'0.875rem 1rem' }}>
                        {!isYou && (
                          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                            <button onClick={()=>toggleActive(u)}
                              style={{ background:'none', border:'1.5px solid #ddd', borderRadius:6, padding:'0.3rem 0.75rem', fontSize:12, cursor:'pointer', color:'#666', whiteSpace:'nowrap' }}>
                              {u.active?'Disable':'Enable'}
                            </button>
                            <button onClick={()=>deleteUser(u)}
                              title="Delete user"
                              style={{ background:'#fef2f2', border:'1.5px solid #fca5a5', borderRadius:6, padding:'0.3rem 0.6rem', fontSize:12, cursor:'pointer', color:'#c0392b', display:'flex', alignItems:'center', gap:4, whiteSpace:'nowrap' }}
                              onMouseEnter={e=>{ e.currentTarget.style.background='#fdecea'; e.currentTarget.style.borderColor='#c0392b'; }}
                              onMouseLeave={e=>{ e.currentTarget.style.background='#fef2f2'; e.currentTarget.style.borderColor='#fca5a5'; }}>
                              <Trash2 size={13}/> Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!users.length && <tr><td colSpan={6} style={{ padding:'2rem', textAlign:'center', color:'#aaa', fontSize:13 }}>No users yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {showAdd && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}>
          <div style={{ background:'white', borderRadius:12, padding:'1.75rem', width:'100%', maxWidth:440 }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>Invite user</h2>
            <p style={{ fontSize:13, color:'#888', marginBottom:'1.25rem' }}>They sign in with the Google account matching this email.</p>
            {error && <div style={{ background:'#fdecea', color:'#c0392b', padding:'0.5rem 0.75rem', borderRadius:6, fontSize:12, marginBottom:'1rem' }}>{error}</div>}
            <label style={labelStyle}>Full name</label>
            <input value={form.full_name} onChange={e=>setForm(f=>({...f,full_name:e.target.value}))} placeholder="Jane Smith" style={{...inputStyle,marginBottom:'1rem'}}/>
            <label style={labelStyle}>Google email</label>
            <input type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jane@oberlin.edu" style={{...inputStyle,marginBottom:'1rem'}}/>
            <label style={labelStyle}>Role</label>
            <div style={{ display:'flex', gap:8, marginBottom:'1rem' }}>
              {['reviewer','admin'].map(r=>(
                <button key={r} onClick={()=>setForm(f=>({...f,role:r}))}
                  style={{ flex:1, padding:'0.5rem', borderRadius:6, border:'1.5px solid', fontSize:13, cursor:'pointer', fontWeight:form.role===r?600:400, borderColor:form.role===r?'#3a8c3f':'#ddd', background:form.role===r?'#e8f5e9':'white', color:form.role===r?'#2a6b2e':'#555', display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
                  {r==='admin'?<Shield size={13}/>:<Eye size={13}/>} {r}
                </button>
              ))}
            </div>
            {form.role==='reviewer' && sources.length>0 && (
              <>
                <label style={labelStyle}>Assign sources <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0 }}>(empty = all)</span></label>
                <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:'1rem', maxHeight:160, overflowY:'auto' }}>
                  {sources.map(s=>(
                    <label key={s.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'0.3rem 0.4rem', borderRadius:4, background:form.source_ids.includes(s.id)?'#e8f5e9':'transparent' }}>
                      <input type="checkbox" checked={form.source_ids.includes(s.id)} onChange={()=>toggleSource(s.id)}/> {s.name}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div style={{ background:'#e8f5e9', borderRadius:6, padding:'0.6rem 0.75rem', fontSize:12, color:'#2a6b2e', marginBottom:'1.25rem' }}>
              They can sign in immediately with their Google account.
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={()=>{setShowAdd(false);setError('');}} className="btn-ghost" style={{ fontSize:13 }}>Cancel</button>
              <button onClick={invite} disabled={!form.email||!form.full_name||adding} className="btn-primary" style={{ fontSize:13 }}>
                {adding?'Inviting…':'Add user'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
const labelStyle: React.CSSProperties = { fontSize:11, fontWeight:700, color:'#666', textTransform:'uppercase', letterSpacing:0.5, display:'block', marginBottom:4 };
const inputStyle: React.CSSProperties = { width:'100%', padding:'0.6rem 0.75rem', border:'1.5px solid #ddd', borderRadius:6, fontSize:13, outline:'none', boxSizing:'border-box' };
