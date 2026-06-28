import { useEffect, useMemo, useRef, useState } from 'react';

// AR Copilot - the AR Dashboard's own assistant (sibling of the Cashflow CFO
// Copilot). Deterministic, answers ONLY from live AR data via /api/ar-assistant.
// Blue theme so it's visually distinct from the green cashflow bot.

const STARTERS = [
  'How much AR is outstanding?',
  'Who owes us the most?',
  'What is overdue?',
  'What is our DSO?',
  'How much did we collect this month?',
  'Which customers are going quiet?',
];

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function readMe() {
  try {
    const name = sessionStorage.getItem('lt_name') || '';
    const title = sessionStorage.getItem('lt_title') || (name.toLowerCase() === 'joey' ? 'CEO' : name.toLowerCase() === 'rishi' ? 'CFO' : '');
    return { name, title };
  } catch {
    return { name: '', title: '' };
  }
}

async function askAr(question, user) {
  const res = await fetch('/api/ar-assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, user }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function ArCopilot() {
  const me = useMemo(readMe, []);
  const firstName = me.name ? me.name.split(/\s+/)[0] : '';

  const greeting = useMemo(() => ({
    role: 'bot',
    title: firstName ? `${timeGreeting()}, ${firstName} 👋` : `${timeGreeting()} 👋`,
    lines: [`I'm your AR copilot - ask me about outstanding money, who to chase, DSO, collections, sales or any customer.`],
    suggestions: STARTERS,
  }), [firstName]);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState([greeting]);
  const [waving, setWaving] = useState(true);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs, busy, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 80); }, [open]);

  useEffect(() => {
    const id = 'ar-wave-style';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      @keyframes arWave { 0%{transform:rotate(0)} 15%{transform:rotate(15deg)} 30%{transform:rotate(-9deg)} 45%{transform:rotate(15deg)} 60%{transform:rotate(-9deg)} 75%{transform:rotate(11deg)} 100%{transform:rotate(0)} }
      @keyframes arBubblePop { 0%{opacity:0;transform:translateY(8px) scale(.6)} 18%{opacity:1;transform:translateY(0) scale(1)} 82%{opacity:1;transform:translateY(0) scale(1)} 100%{opacity:0;transform:translateY(-5px) scale(.9)} }
      @keyframes arblink { 0%,100%{opacity:.3} 50%{opacity:1} }`;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (open) { setWaving(false); return; }
    setWaving(true);
    const stop = setTimeout(() => setWaving(false), 1300);
    const iv = setInterval(() => { setWaving(true); setTimeout(() => setWaving(false), 1300); }, 8000);
    return () => { clearTimeout(stop); clearInterval(iv); };
  }, [open]);

  async function send(q) {
    const question = (q || '').trim();
    if (!question || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const res = await askAr(question, me.name ? me : undefined);
      setMsgs((m) => [...m, { role: 'bot', title: res.title, lines: res.lines || [], note: res.note, suggestions: res.suggestions }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'bot', title: `Sorry, I couldn't reach the AR data just now.`, lines: [`(${e?.message || 'error'}) Try again in a moment.`] }]);
    } finally {
      setBusy(false);
    }
  }

  const BLUE = 'linear-gradient(135deg, #1d4ed8, #3b82f6)';

  return (
    <>
      {!open && waving && (
        <div style={{ position: 'fixed', right: 22, bottom: 104, zIndex: 9998, background: '#fff', color: '#1e3a8a', fontWeight: 700, fontSize: 14, padding: '8px 14px', borderRadius: 16, borderBottomRightRadius: 4, boxShadow: '0 8px 22px rgba(0,0,0,0.18)', border: '1px solid #dbeafe', animation: 'arBubblePop 1.3s ease-in-out', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          👋 {firstName ? `Hi ${firstName}!` : 'Ask me about AR!'}
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => { if (!open) setWaving(true); }}
        aria-label="AR Copilot"
        style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 9998, width: 72, height: 72, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0, background: open ? BLUE : 'transparent', color: '#fff', boxShadow: open ? '0 8px 28px rgba(29,78,216,0.45)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .15s ease' }}
      >
        {open ? <span style={{ fontSize: 24 }}>✕</span> : (
          <img src="/Bot.png" alt="" style={{ width: 72, height: 72, objectFit: 'contain', filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.32))', transformOrigin: 'bottom center', animation: waving ? 'arWave 1.25s ease-in-out' : 'none' }} />
        )}
      </button>

      {open && (
        <div style={{ position: 'fixed', right: 24, bottom: 96, zIndex: 9999, width: 'min(430px, calc(100vw - 32px))', height: 'min(640px, calc(100vh - 130px))', background: '#fff', borderRadius: 18, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.28)', border: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', fontSize: 14 }}>
          <div style={{ background: BLUE, color: '#fff', padding: '14px 18px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src="/Bot.png" alt="" style={{ width: 42, height: 42, objectFit: 'contain', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))' }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>AR Copilot</div>
                <div style={{ fontSize: 11, opacity: 0.9 }}>{firstName ? `For ${firstName}${me.title ? ` · ${me.title}` : ''}` : 'Live AR data · plain answers'}</div>
              </div>
            </div>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#f8fafc' }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {m.role === 'user' ? (
                  <div style={{ maxWidth: '88%', padding: '10px 13px', borderRadius: 14, borderBottomRightRadius: 4, background: 'linear-gradient(135deg, #1d4ed8, #2563eb)', color: '#fff', lineHeight: 1.5, wordBreak: 'break-word' }}>{m.text}</div>
                ) : (
                  <>
                    <div style={{ maxWidth: '92%', padding: '11px 14px', borderRadius: 14, borderBottomLeftRadius: 4, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                      <div style={{ fontWeight: 700, color: '#1e40af', marginBottom: (m.lines && m.lines.length) ? 6 : 0 }}>{m.title}</div>
                      {(m.lines || []).map((ln, j) => {
                        const bullet = ln.trimStart().startsWith('•');
                        return <div key={j} style={{ margin: '3px 0', paddingLeft: bullet ? 6 : 0, color: '#1f2937' }}>{bullet ? ln.replace(/^\s*•\s*/, '• ') : ln}</div>;
                      })}
                      {m.note && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e5e7eb', fontSize: 12, color: '#64748b', display: 'flex', gap: 6 }}>
                          <span style={{ flexShrink: 0 }}>ⓘ</span><span>{m.note}</span>
                        </div>
                      )}
                    </div>
                    {m.suggestions && m.suggestions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {m.suggestions.map((s) => (
                          <button key={s} onClick={() => send(s)} disabled={busy} style={{ fontSize: 12, padding: '5px 10px', borderRadius: 999, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: busy ? 'default' : 'pointer', fontWeight: 500 }}>{s}</button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ display: 'flex', gap: 4, padding: '8px 4px' }}>
                {[0, 1, 2].map((d) => <span key={d} style={{ width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', animation: `arblink 1s ${d * 0.15}s infinite` }} />)}
              </div>
            )}
          </div>

          <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(input); }} placeholder="Ask me anything about AR…" style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1px solid #d1d5db', fontSize: 14, outline: 'none' }} />
              <button onClick={() => send(input)} disabled={busy || !input.trim()} style={{ padding: '0 16px', borderRadius: 12, border: 'none', background: busy || !input.trim() ? '#9ca3af' : BLUE, color: '#fff', cursor: busy || !input.trim() ? 'default' : 'pointer', fontWeight: 700, fontSize: 16 }}>➤</button>
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', marginTop: 6 }}>Answers come live from your AR data</div>
          </div>
        </div>
      )}
    </>
  );
}
