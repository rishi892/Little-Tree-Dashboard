import { useState, useRef, useEffect } from 'react'
import { uid, submitReview, fetchReviews, isResolved } from '../lib/reviews.js'
import { REVIEW_LOCATIONS } from '../lib/reviewLocations.js'

const MAX_IMG = 4 * 1024 * 1024 // 4 MB
const SEEN_KEY = 'lt_review_seen' // resolved-review ids this browser has acknowledged

// Floating "Review" button (everyone) + a toast that tells a user when one of
// THEIR reviews has been resolved. The CFO's resolve queue lives in the
// "Reviews" sidebar page (pages/Reviews.jsx).
export default function ReviewWidget({ activePage }) {
  const user = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lt_user')) || 'unknown user'
  const role = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lt_role')) || ''

  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [shot, setShot] = useState(null) // { name, dataUrl }
  const [status, setStatus] = useState('idle') // idle | sending | sent | error
  const fileRef = useRef(null)
  const [toasts, setToasts] = useState([])

  // Location picker: Section › Tab › Sub-tab - pinpoints WHERE something looks
  // wrong. Section defaults to whatever page the reviewer is currently on.
  const SECTIONS = Object.keys(REVIEW_LOCATIONS)
  const defaultSection = SECTIONS.includes(activePage) ? activePage : SECTIONS[0]
  const [section, setSection] = useState(defaultSection)
  const [tab, setTab] = useState('')
  const [subtab, setSubtab] = useState('')
  // Keep section synced to the page the user opens the widget from.
  useEffect(() => {
    if (open) { setSection(SECTIONS.includes(activePage) ? activePage : SECTIONS[0]); setTab(''); setSubtab('') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activePage])
  const tabsForSection = REVIEW_LOCATIONS[section] || {}
  const tabNames = Object.keys(tabsForSection)
  const subtabsForTab = (tab && tabsForSection[tab]) || []

  // Notify the signed-in user about THEIR reviews that got resolved.
  useEffect(() => {
    let alive = true
    fetchReviews().then((rs) => {
      if (!alive) return
      let seen = []
      try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') } catch { /* ignore */ }
      const mine = rs.filter((r) => r.user === user && isResolved(r.status) && r.id && !seen.includes(r.id))
      if (mine.length) {
        setToasts(mine)
        try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...mine.map((r) => r.id)])) } catch { /* ignore */ }
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [user])

  const readImage = (f, fallbackName) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { alert('Please choose an image file.'); return }
    if (f.size > MAX_IMG) { alert('Image is too large (max 4 MB).'); return }
    const reader = new FileReader()
    reader.onload = () => setShot({ name: f.name || fallbackName, dataUrl: String(reader.result) })
    reader.readAsDataURL(f)
  }
  const onFile = (e) => { readImage(e.target.files?.[0]); e.target.value = '' }
  const onPaste = (e) => {
    const items = e.clipboardData?.items || []
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) { readImage(f, 'pasted-screenshot.png'); e.preventDefault() }
        return
      }
    }
  }

  const reset = () => { setComment(''); setShot(null); setStatus('idle'); setTab(''); setSubtab(''); if (fileRef.current) fileRef.current.value = '' }
  const close = () => { setOpen(false); if (status === 'sent') reset() }

  const submit = async () => {
    if (!comment.trim() || status === 'sending') return
    setStatus('sending')
    const payload = {
      action: 'submit', id: uid(), user, role,
      page: activePage || '', section, tab, subtab,
      comment: comment.trim(),
      screenshot: shot?.dataUrl || '', screenshotName: shot?.name || '',
      at: new Date().toISOString(), agent: navigator.userAgent,
    }
    try {
      const q = JSON.parse(localStorage.getItem('lt_reviews') || '[]')
      q.push({ ...payload, screenshot: shot ? '[image]' : '' })
      localStorage.setItem('lt_reviews', JSON.stringify(q.slice(-25)))
    } catch { /* ignore */ }
    try {
      await submitReview(payload)
      setStatus('sent'); setTimeout(close, 1400)
    } catch { setStatus('error') }
  }

  return (
    <>
      {toasts.length > 0 && (
        <div className="review-toasts">
          {toasts.map((t) => (
            <div key={t.id} className="review-toast">
              <span className="review-toast-tick">✓</span>
              <div>
                <b>Resolved:</b> your review on “{t.page}” is done{t.note ? ` - ${t.note}` : ''}.
                <div className="review-toast-sub">{t.comment.slice(0, 90)}{t.comment.length > 90 ? '…' : ''}</div>
              </div>
              <button className="review-toast-x" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} aria-label="Dismiss">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="review-fabs">
        <button className="review-fab" onClick={() => setOpen(true)} title="Leave a review or report something that looks wrong">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
          <span>Review</span>
        </button>
      </div>

      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal review-modal" onClick={(e) => e.stopPropagation()} onPaste={onPaste} role="dialog" aria-modal="true">
            <header className="modal-head">
              <div className="modal-head-inner">
                <div>
                  <div className="modal-eyebrow">Feedback</div>
                  <h3 className="modal-title">Leave a review</h3>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    as <b>{user}</b>{role ? ` · ${role}` : ''} · on “{activePage}”
                  </div>
                </div>
              </div>
              <button className="modal-close" onClick={close} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </header>
            <div className="modal-body">
              {status === 'sent' ? (
                <div className="review-sent"><div className="review-sent-tick">✓</div><p>Thanks! Your review has been submitted.</p></div>
              ) : (
                <>
                  <label className="review-label">Where is it? (Section › Tab › Sub-tab)</label>
                  <div className="review-loc">
                    <select value={section} onChange={(e) => { setSection(e.target.value); setTab(''); setSubtab('') }}>
                      {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select value={tab} onChange={(e) => { setTab(e.target.value); setSubtab('') }} disabled={tabNames.length === 0}>
                      <option value="">{tabNames.length ? 'Whole page…' : '- no tabs -'}</option>
                      {tabNames.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select value={subtab} onChange={(e) => setSubtab(e.target.value)} disabled={subtabsForTab.length === 0}>
                      <option value="">{subtabsForTab.length ? 'Whole tab…' : '-'}</option>
                      {subtabsForTab.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <label className="review-label" htmlFor="review-comment">Your comment / what looks wrong</label>
                  <textarea id="review-comment" className="review-textarea" rows={5} autoFocus
                    placeholder="Describe your feedback, or what looks incorrect on this page…"
                    value={comment} onChange={(e) => setComment(e.target.value)} />
                  <label className="review-label">Screenshot (optional)</label>
                  {shot ? (
                    <div className="review-shot">
                      <img src={shot.dataUrl} alt="screenshot preview" />
                      <button type="button" className="review-shot-remove" onClick={() => { setShot(null); if (fileRef.current) fileRef.current.value = '' }}>✕ Remove</button>
                    </div>
                  ) : (
                    <label className="review-upload">
                      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} hidden />
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>Upload a screenshot, or press <b>Ctrl + V</b> to paste one</span>
                    </label>
                  )}
                  {status === 'error' && <div className="review-error">Couldn’t reach the review server, but your review was saved locally. Try again or check the webhook setup.</div>}
                  <div className="review-actions">
                    <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={submit} disabled={!comment.trim() || status === 'sending'}>
                      {status === 'sending' ? 'Submitting…' : 'Submit review'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
