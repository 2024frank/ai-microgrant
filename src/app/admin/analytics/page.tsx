'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { Bot, CheckCircle, XCircle, Edit3, Zap, Clock, AlertTriangle, TrendingUp, Activity, Target, RefreshCw } from 'lucide-react';

// ─── colour palette ───────────────────────────────────────────────
const SOURCE_COLORS = ['#3a8c3f','#1565c0','#c05e00','#7b1fa2','#c0392b','#00838f'];
const GRADE_COLOR: Record<string,{bg:string;fg:string}> = {
  A:{bg:'#e8f5e9',fg:'#2a6b2e'}, B:{bg:'#e3f2fd',fg:'#1565c0'},
  C:{bg:'#fff8e1',fg:'#c05e00'}, D:{bg:'#fff3e0',fg:'#e65100'},
  F:{bg:'#fdecea',fg:'#c0392b'},
};

// ─── tiny helpers ─────────────────────────────────────────────────
function fmtSec(s: number | null) {
  if (s == null || s === 0) return '—';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s/60)}m ${s%60}s`;
}
function ago(dt: string | null) {
  if (!dt) return 'never';
  const ms = Date.now() - new Date(dt).getTime();
  const m = Math.floor(ms/60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
function pct(n: number, d: number) { return d>0 ? Math.round(n/d*100) : 0; }

// ─── SVG mini-bar ─────────────────────────────────────────────────
function MiniBar({value,max,color,h=6}:{value:number;max:number;color:string;h?:number}) {
  const w = max>0 ? Math.min(100,Math.round(value/max*100)) : 0;
  return (
    <div style={{background:'#eee',borderRadius:4,height:h,flex:1,overflow:'hidden'}}>
      <div style={{background:color,height:h,width:`${w}%`,transition:'width .5s ease',borderRadius:4}}/>
    </div>
  );
}

// ─── Stacked horizontal bar ───────────────────────────────────────
function StackedBar({approved,rejected,pending,total}:{approved:number;rejected:number;pending:number;total:number}) {
  if (total===0) return <div style={{height:10,background:'#eee',borderRadius:4}}/>;
  const ap=pct(approved,total), rj=pct(rejected,total), pe=pct(pending,total);
  return (
    <div style={{display:'flex',height:10,borderRadius:4,overflow:'hidden',gap:1}}>
      {ap>0&&<div style={{width:`${ap}%`,background:'#3a8c3f'}} title={`Approved: ${approved}`}/>}
      {rj>0&&<div style={{width:`${rj}%`,background:'#c0392b'}} title={`Rejected: ${rejected}`}/>}
      {pe>0&&<div style={{width:`${pe}%`,background:'#e0e0e0'}} title={`Pending: ${pending}`}/>}
    </div>
  );
}

// ─── SVG trend sparkline ──────────────────────────────────────────
function Sparkline({data,color='#3a8c3f',width=120,height=36}:{data:number[];color?:string;width?:number;height?:number}) {
  if (!data.length) return <svg width={width} height={height}/>;
  const max = Math.max(...data,1);
  const pts = data.map((v,i)=>{
    const x = data.length===1 ? width/2 : (i/(data.length-1))*width;
    const y = height - (v/max)*(height-4) - 2;
    return `${x},${y}`;
  });
  const area = `M${pts[0]} ${pts.map((p,i)=>i===0?`L${p}`:`L${p}`).join(' ')} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} style={{display:'block'}}>
      <defs>
        <linearGradient id={`sg${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25}/>
          <stop offset="100%" stopColor={color} stopOpacity={0}/>
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg${color.replace('#','')})`}/>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round"/>
    </svg>
  );
}

// ─── SVG grouped bar chart ────────────────────────────────────────
function GroupedBars({sources,days}:{sources:any[];days:string}) {
  const W=540, H=160, padL=40, padB=28, padT=12, padR=12;
  const inner = {w:W-padL-padR, h:H-padT-padB};
  if (!sources.length) return null;
  const maxVal = Math.max(...sources.map(s=>s.total),1);
  const groupW = inner.w/sources.length;
  const barW   = Math.min(32, groupW/3-2);
  const yScale = (v:number)=>inner.h - (v/maxVal)*inner.h;
  const yTicks = [0,25,50,75,100].map(p=>Math.round(maxVal*p/100));
  return (
    <svg width={W} height={H} style={{overflow:'visible'}}>
      {/* grid */}
      {yTicks.map(t=>{
        const y=padT+yScale(t);
        return <g key={t}>
          <line x1={padL} x2={W-padR} y1={y} y2={y} stroke="#eee" strokeWidth={1}/>
          <text x={padL-4} y={y+4} textAnchor="end" fontSize={9} fill="#bbb">{t}</text>
        </g>;
      })}
      {sources.map((s,i)=>{
        const cx=padL+(i+0.5)*groupW;
        const bars=[
          {val:s.total,    color:'#e0e0e0',  off:-barW-1},
          {val:s.approved, color:'#3a8c3f',  off:0},
          {val:s.pending,  color:'#e67e22',  off:barW+1},
        ];
        return <g key={s.id}>
          {bars.map(({val,color,off})=>{
            const bh=Math.max(2,(val/maxVal)*inner.h);
            const y=padT+yScale(val);
            return <rect key={off} x={cx+off-barW/2} y={y} width={barW} height={bh}
              fill={color} rx={2} opacity={0.9}>
              <title>{s.name}: {val}</title>
            </rect>;
          })}
          <text x={cx} y={H-padB+14} textAnchor="middle" fontSize={9} fill="#888">
            {s.name.split(' ').map((w:string)=>w[0]).join('')}
          </text>
        </g>;
      })}
      {/* legend */}
      {[{c:'#e0e0e0',l:'Total'},{c:'#3a8c3f',l:'Approved'},{c:'#e67e22',l:'Pending'}].map(({c,l},i)=>(
        <g key={l} transform={`translate(${padL+i*72},${H-2})`}>
          <rect width={8} height={8} fill={c} rx={1}/>
          <text x={11} y={7} fontSize={9} fill="#888">{l}</text>
        </g>
      ))}
    </svg>
  );
}

// ─── Donut chart ──────────────────────────────────────────────────
function Donut({slices,r=40,stroke=12}:{slices:{value:number;color:string;label:string}[];r?:number;stroke?:number}) {
  const total=slices.reduce((s,sl)=>s+sl.value,0);
  if (!total) return (
    <svg width={r*2+stroke} height={r*2+stroke} viewBox={`0 0 ${r*2+stroke} ${r*2+stroke}`}>
      <circle cx={r+stroke/2} cy={r+stroke/2} r={r} fill="none" stroke="#eee" strokeWidth={stroke}/>
    </svg>
  );
  const cx=r+stroke/2, cy=r+stroke/2, circ=2*Math.PI*r;
  let offset=0;
  return (
    <svg width={r*2+stroke} height={r*2+stroke} viewBox={`0 0 ${r*2+stroke} ${r*2+stroke}`} style={{transform:'rotate(-90deg)'}}>
      {slices.map(sl=>{
        const dash=(sl.value/total)*circ;
        const el=<circle key={sl.label} cx={cx} cy={cy} r={r} fill="none"
          stroke={sl.color} strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ-dash}`}
          strokeDashoffset={-offset}>
          <title>{sl.label}: {sl.value}</title>
        </circle>;
        offset+=dash;
        return el;
      })}
    </svg>
  );
}

// ─── Run timeline strip ───────────────────────────────────────────
function RunTimeline({runs}:{runs:any[]}) {
  const last = runs.slice(0,20);
  return (
    <div style={{display:'flex',gap:3,alignItems:'flex-end',height:40}}>
      {last.reverse().map((r:any,i:number)=>{
        const h=Math.max(4,Math.min(40, r.events_extracted>0 ? 8+(r.events_extracted/5)*4 : 4));
        const color=r.status==='failed'?'#c0392b':r.events_extracted>0?'#3a8c3f':'#e0e0e0';
        return <div key={r.id} title={`${r.source_name}: ${r.events_extracted} events (${fmtSec(r.duration_sec)})`}
          style={{width:10,height:h,background:color,borderRadius:2,flexShrink:0}}/>;
      })}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────
function KPI({label,value,sub,color='#333',icon}:{label:string;value:string|number;sub?:string;color?:string;icon?:React.ReactNode}) {
  return (
    <div className="card" style={{padding:'1rem 1.25rem'}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
        {icon&&<span style={{color}}>{icon}</span>}
        <span style={{fontSize:11,fontWeight:700,color:'#999',textTransform:'uppercase',letterSpacing:.5}}>{label}</span>
      </div>
      <div style={{fontSize:28,fontWeight:800,color,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:'#bbb',marginTop:3}}>{sub}</div>}
    </div>
  );
}

// ─── Grade badge ─────────────────────────────────────────────────
function Grade({g}:{g:string|null}) {
  if (!g) return <span style={{fontSize:11,color:'#bbb',fontWeight:700}}>N/A</span>;
  const {bg,fg}=GRADE_COLOR[g]||{bg:'#eee',fg:'#666'};
  return <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:36,height:36,borderRadius:8,background:bg,color:fg,fontWeight:800,fontSize:18}}>{g}</span>;
}

// ─── Main page ────────────────────────────────────────────────────
export default function AgentAnalyticsPage() {
  const {user,token,ready}=useAuth('admin');
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(true);
  const [days,setDays]=useState('30');
  const [activeTab,setActiveTab]=useState<'overview'|'agents'|'runs'|'fields'>('overview');

  useEffect(()=>{
    if (!ready||!token) return;
    setLoading(true);
    fetch(`/api/admin/agent-analytics?days=${days}`,{headers:{Authorization:`Bearer ${token}`}})
      .then(r=>r.json()).then(d=>setData(d)).finally(()=>setLoading(false));
  },[ready,token,days]);

  if (!ready||!user) return null;

  const sources:any[]  = data?.sources  || [];
  const runs:any[]     = data?.runs     || [];
  const trend:any[]    = data?.trend    || [];
  const topFields:any[]= data?.top_fields||[];

  // Summary totals
  const totals={
    events:   sources.reduce((s,r)=>s+r.total,0),
    approved: sources.reduce((s,r)=>s+r.approved,0),
    rejected: sources.reduce((s,r)=>s+r.rejected,0),
    pending:  sources.reduce((s,r)=>s+r.pending,0),
    edited:   sources.reduce((s,r)=>s+r.edited,0),
    runs:     sources.reduce((s,r)=>s+r.total_runs,0),
    empty:    sources.reduce((s,r)=>s+r.empty_runs,0),
    failed:   sources.reduce((s,r)=>s+r.failed_runs,0),
  };
  const overallApprovalRate = (totals.approved+totals.rejected)>0
    ? Math.round(totals.approved/(totals.approved+totals.rejected)*100) : null;
  const hitRate = totals.runs>0
    ? Math.round((totals.runs-totals.empty)/totals.runs*100) : null;

  // Trend sparklines per source
  const sparkData: Record<string,number[]> = {};
  for (const r of trend) {
    if (!sparkData[r.source_name]) sparkData[r.source_name]=[];
    sparkData[r.source_name].push(Number(r.extracted||0));
  }

  const selectStyle:React.CSSProperties={padding:'0.4rem 0.75rem',border:'1.5px solid #ddd',borderRadius:6,fontSize:13,outline:'none',background:'white'};
  const tabStyle=(active:boolean):React.CSSProperties=>({
    padding:'0.4rem 1rem',fontSize:13,fontWeight:active?700:500,borderRadius:6,cursor:'pointer',
    background:active?'#3a8c3f':'transparent',color:active?'white':'#666',border:'none',
  });

  return (
    <div style={{display:'flex',minHeight:'100vh',background:'#f8f9fa'}}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token}/>
      <main style={{flex:1,padding:'2rem',overflowY:'auto',maxWidth:1200}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.5rem',flexWrap:'wrap',gap:8}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:700,marginBottom:2}}>AI Agent Intelligence</h1>
            <p style={{fontSize:13,color:'#888',margin:0}}>Deep analytics on how your agents extract, learn, and improve</p>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <select value={days} onChange={e=>setDays(e.target.value)} style={selectStyle}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">All time</option>
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div style={{display:'flex',gap:4,marginBottom:'1.5rem',background:'white',padding:4,borderRadius:8,width:'fit-content',boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}>
          {(['overview','agents','runs','fields'] as const).map(t=>(
            <button key={t} style={tabStyle(activeTab===t)} onClick={()=>setActiveTab(t)}>
              {t.charAt(0).toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>

        {loading ? <div style={{color:'#888',fontSize:14,padding:'3rem',textAlign:'center'}}>Loading analytics…</div> : (

        <>
        {/* ═══ OVERVIEW TAB ═══════════════════════════════════════ */}
        {activeTab==='overview' && (
          <>
            {/* KPI row */}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'1rem',marginBottom:'1.5rem'}}>
              <KPI label="Events extracted" value={totals.events} icon={<Zap size={14}/>} color="#3a8c3f"
                sub={`across ${sources.filter(s=>s.active).length} active agents`}/>
              <KPI label="Agent runs" value={totals.runs} icon={<RefreshCw size={14}/>} color="#1565c0"
                sub={`${totals.empty} empty · ${totals.failed} failed`}/>
              <KPI label="Hit rate" value={hitRate!==null?`${hitRate}%`:'—'} icon={<Target size={14}/>}
                color={hitRate===null?'#bbb':hitRate>=60?'#3a8c3f':hitRate>=30?'#c05e00':'#c0392b'}
                sub="runs that found new events"/>
              <KPI label="Approval rate" value={overallApprovalRate!==null?`${overallApprovalRate}%`:'—'}
                icon={<CheckCircle size={14}/>}
                color={overallApprovalRate===null?'#bbb':overallApprovalRate>=70?'#3a8c3f':overallApprovalRate>=50?'#c05e00':'#c0392b'}
                sub="of reviewed events approved"/>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:'1.25rem',marginBottom:'1.25rem'}}>
              {/* Grouped bar chart */}
              <div className="card" style={{padding:'1.25rem'}}>
                <h3 style={{fontSize:13,fontWeight:700,marginBottom:'1rem',color:'#444'}}>Events by source</h3>
                <GroupedBars sources={sources} days={days}/>
              </div>

              {/* Status donut */}
              <div className="card" style={{padding:'1.25rem',display:'flex',flexDirection:'column',alignItems:'center',gap:'1rem'}}>
                <h3 style={{fontSize:13,fontWeight:700,color:'#444',alignSelf:'flex-start'}}>Review status</h3>
                <Donut slices={[
                  {value:totals.approved,color:'#3a8c3f',label:'Approved'},
                  {value:totals.rejected,color:'#c0392b',label:'Rejected'},
                  {value:totals.pending, color:'#e0e0e0',label:'Pending'},
                ]} r={52} stroke={18}/>
                <div style={{display:'flex',flexDirection:'column',gap:6,width:'100%'}}>
                  {[
                    {label:'Approved',val:totals.approved,color:'#3a8c3f'},
                    {label:'Rejected',val:totals.rejected,color:'#c0392b'},
                    {label:'Pending', val:totals.pending, color:'#e0e0e0'},
                  ].map(({label,val,color})=>(
                    <div key={label} style={{display:'flex',alignItems:'center',gap:8}}>
                      <div style={{width:8,height:8,borderRadius:2,background:color,flexShrink:0}}/>
                      <span style={{fontSize:12,flex:1,color:'#666'}}>{label}</span>
                      <span style={{fontSize:12,fontWeight:700,color:'#333'}}>{val}</span>
                      <span style={{fontSize:11,color:'#bbb',width:36,textAlign:'right'}}>{pct(val,totals.events)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Run timeline */}
            <div className="card" style={{padding:'1.25rem',marginBottom:'1.25rem'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.75rem'}}>
                <h3 style={{fontSize:13,fontWeight:700,color:'#444'}}>Recent run timeline</h3>
                <span style={{fontSize:11,color:'#bbb'}}>each bar = 1 run · height = events extracted · grey = empty run · red = failed</span>
              </div>
              <RunTimeline runs={runs}/>
              <div style={{display:'flex',gap:'1.5rem',marginTop:'0.75rem',flexWrap:'wrap'}}>
                {sources.filter(s=>s.total_runs>0).map((s,i)=>(
                  <div key={s.id} style={{display:'flex',flexDirection:'column',gap:4,minWidth:100}}>
                    <div style={{fontSize:11,fontWeight:600,color:'#555'}}>{s.name}</div>
                    <Sparkline data={sparkData[s.name]||[]} color={SOURCE_COLORS[i%SOURCE_COLORS.length]} width={100} height={28}/>
                    <div style={{fontSize:10,color:'#bbb'}}>{s.total_runs} runs · {s.productive_runs} productive</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Insights */}
            <div className="card" style={{padding:'1.25rem'}}>
              <h3 style={{fontSize:13,fontWeight:700,color:'#444',marginBottom:'0.75rem',display:'flex',alignItems:'center',gap:6}}>
                <Activity size={13} color="#3a8c3f"/> AI Insights
              </h3>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {sources.filter(s=>s.total_runs>0).map(s=>{
                  const insights:string[]=[];
                  if (s.hit_rate!==null&&s.hit_rate<30) insights.push(`Low hit rate (${s.hit_rate}%) — agent runs often find nothing new. Consider reducing run frequency or improving dedup logic.`);
                  if (s.edit_rate>40) insights.push(`High edit rate (${s.edit_rate}%) — reviewers are frequently correcting extracted fields. The agent may need prompt tuning.`);
                  if (s.avg_sec&&s.avg_sec>300) insights.push(`Slow runs averaging ${fmtSec(Math.round(s.avg_sec))} — may indicate the source API is slow or the agent is doing excess work.`);
                  if (s.failed_runs>0) insights.push(`${s.failed_runs} failed run${s.failed_runs>1?'s':''} detected — check agent logs.`);
                  if (s.pending>0&&s.approved===0) insights.push(`${s.pending} events pending — none reviewed yet.`);
                  if (!insights.length) return null;
                  return (
                    <div key={s.id} style={{background:'#fffbf0',borderLeft:'3px solid #e67e22',borderRadius:'0 6px 6px 0',padding:'0.6rem 0.75rem'}}>
                      <div style={{fontSize:12,fontWeight:700,color:'#c05e00',marginBottom:4}}>{s.name}</div>
                      {insights.map((ins,i)=>(
                        <div key={i} style={{fontSize:12,color:'#666',marginBottom:i<insights.length-1?3:0}}>• {ins}</div>
                      ))}
                    </div>
                  );
                })}
                {sources.every(s=>!s.total_runs||(s.hit_rate>=30&&s.edit_rate<=40&&!s.failed_runs))&&(
                  <div style={{fontSize:13,color:'#3a8c3f',fontWeight:600}}>All agents look healthy. Keep reviewing to build approval signals.</div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ═══ AGENTS TAB ══════════════════════════════════════════ */}
        {activeTab==='agents' && (
          <div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
            {sources.map((s,i)=>(
              <div key={s.id} className="card" style={{padding:'1.25rem 1.5rem'}}>
                <div style={{display:'flex',alignItems:'flex-start',gap:'1rem',marginBottom:'1rem'}}>
                  <div style={{width:40,height:40,borderRadius:10,flexShrink:0,background:s.active?'#e8f5e9':'#f0f0f0',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <Bot size={20} color={s.active?'#3a8c3f':'#bbb'}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontSize:15,fontWeight:700}}>{s.name}</span>
                      {!s.active&&<span style={{fontSize:10,background:'#eee',color:'#888',borderRadius:10,padding:'1px 8px',fontWeight:600}}>Inactive</span>}
                      <span style={{fontSize:10,background:s.last_run_status==='failed'?'#fdecea':'#f0f0f0',color:s.last_run_status==='failed'?'#c0392b':'#888',borderRadius:10,padding:'1px 8px',fontWeight:600}}>
                        {s.last_run_status||'no runs'}
                      </span>
                    </div>
                    <div style={{fontSize:11,color:'#bbb',marginTop:2}}>
                      {s.agent_id||'No agent ID'} · Last run {ago(s.last_run_at)}
                    </div>
                  </div>
                  <Grade g={s.grade}/>
                </div>

                {/* Stat grid */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'0.75rem',marginBottom:'1rem'}}>
                  {[
                    {label:'Total runs',    val:s.total_runs,  sub:`${s.productive_runs} productive`,  color:'#1565c0'},
                    {label:'Hit rate',      val:s.hit_rate!==null?`${s.hit_rate}%`:'—', sub:`${s.empty_runs} empty runs`, color:s.hit_rate===null?'#bbb':s.hit_rate>=60?'#3a8c3f':s.hit_rate>=30?'#c05e00':'#c0392b'},
                    {label:'Avg run time',  val:fmtSec(s.avg_sec?Math.round(s.avg_sec):null), sub:`max ${fmtSec(s.max_sec)}`, color:'#555'},
                    {label:'Approval rate', val:s.approval_rate!==null?`${s.approval_rate}%`:'—', sub:`${s.approved} approved`,  color:s.approval_rate===null?'#bbb':s.approval_rate>=70?'#3a8c3f':s.approval_rate>=50?'#c05e00':'#c0392b'},
                  ].map(({label,val,sub,color})=>(
                    <div key={label} style={{background:'#f8f9fa',borderRadius:8,padding:'0.75rem'}}>
                      <div style={{fontSize:20,fontWeight:800,color}}>{val}</div>
                      <div style={{fontSize:10,fontWeight:700,color:'#999',textTransform:'uppercase',letterSpacing:.4}}>{label}</div>
                      <div style={{fontSize:10,color:'#bbb',marginTop:2}}>{sub}</div>
                    </div>
                  ))}
                </div>

                {/* Stacked event bar */}
                <div style={{marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'#bbb',marginBottom:4}}>
                    <span>Events breakdown</span>
                    <span>{s.total} total</span>
                  </div>
                  <StackedBar approved={s.approved} rejected={s.rejected} pending={s.pending} total={s.total}/>
                  <div style={{display:'flex',gap:'1rem',marginTop:6}}>
                    {[{l:'Approved',v:s.approved,c:'#3a8c3f'},{l:'Rejected',v:s.rejected,c:'#c0392b'},{l:'Pending',v:s.pending,c:'#bbb'}].map(({l,v,c})=>(
                      <span key={l} style={{fontSize:10,color:c,fontWeight:600}}>{v} {l}</span>
                    ))}
                  </div>
                </div>

                {/* Edit rate bar */}
                <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8}}>
                  <span style={{fontSize:10,color:'#bbb',width:64,flexShrink:0}}>Field edits</span>
                  <MiniBar value={s.edited} max={Math.max(s.total,1)} color="#1565c0" h={6}/>
                  <span style={{fontSize:10,color:'#1565c0',fontWeight:700,width:36,textAlign:'right'}}>{s.edit_rate}%</span>
                </div>

                {/* Sparkline */}
                {sparkData[s.name]?.length>1&&(
                  <div style={{marginTop:'0.75rem',paddingTop:'0.75rem',borderTop:'1px solid #f0f0f0'}}>
                    <div style={{fontSize:10,color:'#bbb',marginBottom:4}}>Extraction trend</div>
                    <Sparkline data={sparkData[s.name]} color={SOURCE_COLORS[i%SOURCE_COLORS.length]} width={400} height={40}/>
                  </div>
                )}

                {s.approved>0&&(
                  <div style={{marginTop:'0.75rem',fontSize:11,color:'#888'}}>
                    <span style={{color:'#3a8c3f',fontWeight:700}}>{s.clean_approved}</span> of {s.approved} approved events needed zero edits
                    {' '}({pct(s.clean_approved,s.approved)}% clean)
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ═══ RUNS TAB ════════════════════════════════════════════ */}
        {activeTab==='runs' && (
          <div className="card" style={{padding:0,overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'#f8f9fa',borderBottom:'1px solid #eee'}}>
                  {['Agent','Started','Duration','Events found','Events ingested','Status'].map(h=>(
                    <th key={h} style={{padding:'0.75rem 1rem',textAlign:'left',fontSize:11,fontWeight:700,color:'#888',textTransform:'uppercase',letterSpacing:.5}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r:any)=>{
                  const statusColor={completed:'#3a8c3f',failed:'#c0392b',running:'#1565c0'}[r.status as string]||'#888';
                  return (
                    <tr key={r.id} style={{borderBottom:'1px solid #f4f4f4'}}>
                      <td style={{padding:'0.75rem 1rem',fontWeight:600}}>{r.source_name}</td>
                      <td style={{padding:'0.75rem 1rem',color:'#666',fontSize:12}}>
                        {new Date(r.started_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
                      </td>
                      <td style={{padding:'0.75rem 1rem',color:'#666'}}>{fmtSec(r.duration_sec)}</td>
                      <td style={{padding:'0.75rem 1rem',fontWeight:r.events_found>0?700:400,color:r.events_found>0?'#333':'#bbb'}}>
                        {r.events_found||0}
                      </td>
                      <td style={{padding:'0.75rem 1rem'}}>
                        <span style={{fontWeight:700,color:r.events_extracted>0?'#3a8c3f':'#bbb'}}>
                          {r.events_extracted||0}
                        </span>
                        {r.events_found>0&&r.events_extracted<r.events_found&&(
                          <span style={{fontSize:10,color:'#bbb',marginLeft:4}}>(deduped {r.events_found-r.events_extracted})</span>
                        )}
                      </td>
                      <td style={{padding:'0.75rem 1rem'}}>
                        <span style={{fontSize:11,fontWeight:700,color:statusColor,background:statusColor+'18',borderRadius:20,padding:'2px 10px'}}>
                          {r.status}
                        </span>
                        {r.error_log&&<div style={{fontSize:10,color:'#c0392b',marginTop:2}}>Error logged</div>}
                      </td>
                    </tr>
                  );
                })}
                {!runs.length&&<tr><td colSpan={6} style={{padding:'2rem',textAlign:'center',color:'#bbb'}}>No runs in this period</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {/* ═══ FIELDS TAB ══════════════════════════════════════════ */}
        {activeTab==='fields' && (
          <>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'1.25rem',marginBottom:'1.25rem'}}>
              <div className="card" style={{padding:'1.25rem'}}>
                <h3 style={{fontSize:13,fontWeight:700,color:'#444',marginBottom:'1rem',display:'flex',alignItems:'center',gap:6}}>
                  <Edit3 size={13} color="#1565c0"/> Most-edited fields
                </h3>
                {topFields.length===0&&<p style={{fontSize:12,color:'#bbb'}}>No edits recorded yet</p>}
                {topFields.map((f:any,i:number)=>(
                  <div key={f.field_name} style={{marginBottom:'0.625rem'}}>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:3}}>
                      <span style={{fontWeight:600,color:'#555'}}>{f.field_name.replace(/_/g,' ')}</span>
                      <span style={{color:'#888'}}>{f.edits} edits · {f.events_affected} events</span>
                    </div>
                    <MiniBar value={f.edits} max={topFields[0]?.edits||1} color={SOURCE_COLORS[i%SOURCE_COLORS.length]} h={7}/>
                  </div>
                ))}
                {topFields.length>0&&(
                  <p style={{fontSize:11,color:'#bbb',marginTop:'0.75rem'}}>
                    Fields with high edit rates indicate where agents need prompt improvements.
                  </p>
                )}
              </div>

              <div className="card" style={{padding:'1.25rem'}}>
                <h3 style={{fontSize:13,fontWeight:700,color:'#444',marginBottom:'1rem',display:'flex',alignItems:'center',gap:6}}>
                  <TrendingUp size={13} color="#3a8c3f"/> Clean extraction rate
                </h3>
                {sources.map(s=>{
                  const cleanPct = s.approved>0 ? pct(s.clean_approved,s.approved) : null;
                  return (
                    <div key={s.id} style={{marginBottom:'0.75rem'}}>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:3}}>
                        <span style={{fontWeight:600,color:'#555'}}>{s.name}</span>
                        <span style={{color:cleanPct===null?'#bbb':cleanPct>=80?'#3a8c3f':cleanPct>=50?'#c05e00':'#c0392b',fontWeight:700}}>
                          {cleanPct!==null?`${cleanPct}% clean`:'no reviews yet'}
                        </span>
                      </div>
                      <MiniBar value={cleanPct||0} max={100} color={cleanPct===null?'#eee':cleanPct>=80?'#3a8c3f':cleanPct>=50?'#e67e22':'#c0392b'} h={7}/>
                    </div>
                  );
                })}
                <p style={{fontSize:11,color:'#bbb',marginTop:'0.75rem'}}>
                  % of approved events that required zero field corrections.
                </p>
              </div>
            </div>

            <div className="card" style={{padding:'1.25rem'}}>
              <h3 style={{fontSize:13,fontWeight:700,color:'#444',marginBottom:'0.75rem',display:'flex',alignItems:'center',gap:6}}>
                <AlertTriangle size={13} color="#e67e22"/> Agent accuracy summary
              </h3>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'0.75rem'}}>
                {sources.filter(s=>s.total>0).map(s=>(
                  <div key={s.id} style={{background:'#f8f9fa',borderRadius:8,padding:'0.875rem'}}>
                    <div style={{fontSize:12,fontWeight:700,marginBottom:8,color:'#444'}}>{s.name}</div>
                    {[
                      {label:'Events pulled',val:s.total},
                      {label:'Field edits',  val:`${s.edited} (${s.edit_rate}%)`},
                      {label:'Clean rate',   val:s.approved>0?`${pct(s.clean_approved,s.approved)}%`:'—'},
                      {label:'Hit rate',     val:s.hit_rate!==null?`${s.hit_rate}%`:'—'},
                    ].map(({label,val})=>(
                      <div key={label} style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:3}}>
                        <span style={{color:'#888'}}>{label}</span>
                        <span style={{fontWeight:700,color:'#333'}}>{val}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        </>
        )}
      </main>
    </div>
  );
}
