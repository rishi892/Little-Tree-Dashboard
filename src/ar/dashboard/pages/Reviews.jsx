import { useState, useEffect, useCallback } from 'react'
import KpiCard from '../KpiCard.jsx'
import { num } from '../../lib/format.js'
import { usePager, Pager } from '../../lib/pagination.jsx'
import { uid, fetchReviews, submitReview, submitAudit, resolveReview, isResolved } from '../../lib/reviews.js'
import { REVIEW_LOCATIONS, locationBreadcrumb, allowedSections } from '../../lib/reviewLocations.js'

// Review & Audit - two SEPARATE logs, both open to everyone:
//   Review - "this looks wrong here": pick Section › Tab › Sub-tab + describe it.
//   Audit  - "I checked this and it's correct (or found an issue)": pick the
//            location + a verdict. Every record stores WHO did it + WHEN, so
//            leadership (CEO/CFO/CMO) can see who reviewed/audited what & where.
export default function Reviews() {
  const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : null
  const user = (ss && ss.getItem('lt_user')) || 'unknown'
  const role = (ss && ss.getItem('lt_role')) || ''
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(false)
  const [main, setMain] = useState('review') // review | audit

  const load = useCallback(async () => {
    setLoading(true)
    try { setRecords(await fetchReviews()) } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const sections = allowedSections(role)
  const reviews = records.filter((r) => r.kind !== 'audit')
  const audits = records.filter((r) => r.kind === 'audit')

  const addRecord = (rec) => setRecords((rs) => [rec, ...rs])
  const patchRecord = (id, patch) => setRecords((rs) => rs.map((x) => x.id === id ? { ...x, ...patch } : x))

  const openN = reviews.filter((r) => !isResolved(r.status)).length

  return (
    <div className="page">
      <div className="ar-tabs-row review-toggle-row">
        <div className="ar-tabs bigtabs">
          <button className={`ar-tab ${main === 'review' ? 'active' : ''}`} onClick={() => setMain('review')}>
            Review {openN > 0 && <span className="tab-count">{num(openN)}</span>}
          </button>
          <button className={`ar-tab ${main === 'audit' ? 'active' : ''}`} onClick={() => setMain('audit')}>
            Audit {audits.length > 0 && <span className="tab-count">{num(audits.length)}</span>}
          </button>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {main === 'review'
        ? <ReviewTab reviews={reviews} user={user} role={role} sections={sections} loading={loading} onAdd={addRecord} onPatch={patchRecord} />
        : <AuditTab audits={audits} user={user} role={role} sections={sections} loading={loading} onAdd={addRecord} />}
    </div>
  )
}

// ============ SHARED - location picker (Section › Tab › Sub-tab) ============
function LocationPicker({ value, onChange, sections }) {
  const SECTIONS = sections
  const section = value.section || SECTIONS[0]
  const tabs = Object.keys(REVIEW_LOCATIONS[section] || {})
  const subtabs = (value.tab && REVIEW_LOCATIONS[section]?.[value.tab]) || []
  return (
    <div className="review-loc">
      <select value={section} onChange={(e) => onChange({ section: e.target.value, tab: '', subtab: '' })}>
        {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select value={value.tab} onChange={(e) => onChange({ section, tab: e.target.value, subtab: '' })} disabled={tabs.length === 0}>
        <option value="">{tabs.length ? 'Whole page…' : '- no tabs -'}</option>
        {tabs.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={value.subtab} onChange={(e) => onChange({ section, tab: value.tab, subtab: e.target.value })} disabled={subtabs.length === 0}>
        <option value="">{subtabs.length ? 'Whole tab…' : '-'}</option>
        {subtabs.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  )
}

const emptyLoc = () => ({ section: '', tab: '', subtab: '' })

// ============ REVIEW TAB - report something that looks wrong ============
function ReviewTab({ reviews, user, role, sections, loading, onAdd, onPatch }) {
  const [loc, setLoc] = useState(emptyLoc())
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [filter, setFilter] = useState('open') // open | resolved | all
  const [busyId, setBusyId] = useState(null)

  const section = loc.section || sections[0]

  const submit = async () => {
    if (!comment.trim() || sending) return
    setSending(true)
    const rec = {
      id: uid(), user, role, section, tab: loc.tab, subtab: loc.subtab,
      comment: comment.trim(), at: new Date().toISOString(),
      status: 'Under process', resolvedBy: '', resolvedAt: '', note: '', kind: 'review',
    }
    try {
      const saved = await submitReview(rec)
      onAdd({ ...rec, ...saved })
      setComment(''); setLoc(emptyLoc())
    } catch { alert('Could not reach the review server. Try again.') }
    finally { setSending(false) }
  }

  const resolve = async (r, note) => {
    setBusyId(r.id)
    try {
      const updated = await resolveReview(r.id, user, (note || '').trim())
      onPatch(r.id, updated)
    } catch { alert('Could not reach the review server. Try again.') }
    finally { setBusyId(null) }
  }

  const openN = reviews.filter((r) => !isResolved(r.status)).length
  const resolvedN = reviews.length - openN
  const shown = reviews.filter((r) =>
    filter === 'all' ? true : filter === 'resolved' ? isResolved(r.status) : !isResolved(r.status))
  const pager = usePager(shown.length, 20, `${filter}|${reviews.length}|${openN}`)

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Under process" value={num(openN)} sub="Awaiting resolution" tone="warn"
          info={{ title: 'Reviews under process', purpose: 'Flagged issues open and still being worked.', detail: 'Counts review records (kind not "audit") whose status is not yet resolved. Example: if 5 reviews are still open, this shows 5.', source: 'Review & Audit log.' }} />
        <KpiCard label="Resolved" value={num(resolvedN)} sub="Fixed / answered" tone="good"
          info={{ title: 'Reviews resolved', purpose: 'Flagged issues fixed and closed.', detail: 'Total reviews minus the ones still under process (review records with a resolved status). Example: 28 reviews minus 5 open = 23 resolved.', source: 'Review & Audit log.' }} />
        <KpiCard label="Total reviews" value={num(reviews.length)} sub="All time" tone="muted"
          info={{ title: 'Total reviews', purpose: 'Every issue ever flagged.', detail: 'Counts all review records (kind not "audit"), open and resolved together. Example: 5 open + 23 resolved = 28 total.', source: 'Review & Audit log.' }} />
      </section>

      <div className="table-card review-composer">
        <h3 className="composer-title">Leave a review - where does something look wrong?</h3>
        <LocationPicker value={loc} onChange={setLoc} sections={sections} />
        <textarea className="review-textarea" rows={3} placeholder="Describe what looks wrong here…"
          value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="composer-actions">
          <span className="muted" style={{ fontSize: 12 }}>as <b>{user}</b>{role ? ` · ${role}` : ''}</span>
          <button className="btn btn-primary" disabled={!comment.trim() || sending} onClick={submit}>
            {sending ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </div>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${filter === 'open' ? 'active' : ''}`} onClick={() => setFilter('open')}>Under process ({num(openN)})</button>
          <button className={`ar-tab ${filter === 'resolved' ? 'active' : ''}`} onClick={() => setFilter('resolved')}>Resolved ({num(resolvedN)})</button>
          <button className={`ar-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>

      <div className="table-card">
        {shown.length === 0
          ? <div className="table-empty" style={{ padding: 28 }}>{loading ? 'Loading…' : 'No reviews in this view.'}</div>
          : (
            <div className="review-list" style={{ padding: 14 }}>
              {shown.slice(pager.start, pager.end).map((r) => (
                <ReviewCard key={r.id || r.at} r={r} onResolve={resolve} busy={busyId === r.id} />
              ))}
            </div>
          )}
        <Pager {...pager} total={shown.length} />
      </div>
    </>
  )
}

// ============ AUDIT TAB - record a check ("correct" / "issue") ============
function AuditTab({ audits, user, role, sections, loading, onAdd }) {
  const [loc, setLoc] = useState(emptyLoc())
  const [verdict, setVerdict] = useState('correct') // correct | issue
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [filter, setFilter] = useState('all') // all | correct | issue

  const section = loc.section || sections[0]

  const submit = async () => {
    if (sending) return
    if (verdict === 'issue' && !note.trim()) { alert('Please note what the issue is.'); return }
    setSending(true)
    const rec = {
      id: uid(), user, role, section, tab: loc.tab, subtab: loc.subtab,
      verdict, comment: note.trim(), at: new Date().toISOString(), kind: 'audit',
    }
    try {
      const saved = await submitAudit(rec)
      onAdd({ ...rec, ...saved })
      setNote(''); setVerdict('correct'); setLoc(emptyLoc())
    } catch { alert('Could not reach the review server. Try again.') }
    finally { setSending(false) }
  }

  const correctN = audits.filter((a) => a.verdict !== 'issue').length
  const issueN = audits.filter((a) => a.verdict === 'issue').length
  const shown = audits.filter((a) =>
    filter === 'all' ? true : filter === 'issue' ? a.verdict === 'issue' : a.verdict !== 'issue')
  const pager = usePager(shown.length, 20, `${filter}|${audits.length}`)

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Audited correct" value={num(correctN)} sub="Checked · all good" tone="good"
          info={{ title: 'Audited correct', purpose: 'Checks that came back clean.', detail: 'Counts audit records whose verdict is not "issue" (i.e. marked correct). Example: 40 audits came back clean, so this shows 40.', source: 'Review & Audit log.' }} />
        <KpiCard label="Issues found" value={num(issueN)} sub="Need a fix" tone="bad"
          info={{ title: 'Issues found', purpose: 'Checks that surfaced a discrepancy.', detail: 'Counts audit records whose verdict is "issue". Example: 7 audits recorded a problem, so this shows 7.', source: 'Review & Audit log.' }} />
        <KpiCard label="Total audits" value={num(audits.length)} sub="All time" tone="muted"
          info={{ title: 'Total audits', purpose: 'Every audit check logged.', detail: 'Counts all audit records (kind "audit"), clean and flagged together. Example: 40 correct + 7 with issues = 47 total.', source: 'Review & Audit log.' }} />
      </section>

      <div className="table-card review-composer">
        <h3 className="composer-title">Record an audit - what did you check?</h3>
        <LocationPicker value={loc} onChange={setLoc} sections={sections} />
        <div className="audit-verdict">
          <label className={`audit-verdict-opt ${verdict === 'correct' ? 'is-correct' : ''}`}>
            <input type="radio" name="verdict" checked={verdict === 'correct'} onChange={() => setVerdict('correct')} />
            <span>All correct</span>
          </label>
          <label className={`audit-verdict-opt ${verdict === 'issue' ? 'is-issue' : ''}`}>
            <input type="radio" name="verdict" checked={verdict === 'issue'} onChange={() => setVerdict('issue')} />
            <span>Found an issue</span>
          </label>
        </div>
        <textarea className="review-textarea" rows={2}
          placeholder={verdict === 'issue' ? 'What is wrong? (required)' : 'Note (optional)…'}
          value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="composer-actions">
          <span className="muted" style={{ fontSize: 12 }}>as <b>{user}</b>{role ? ` · ${role}` : ''}</span>
          <button className="btn btn-primary" disabled={sending} onClick={submit}>
            {sending ? 'Saving…' : 'Submit audit'}
          </button>
        </div>
      </div>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All ({num(audits.length)})</button>
          <button className={`ar-tab ${filter === 'correct' ? 'active' : ''}`} onClick={() => setFilter('correct')}>Correct ({num(correctN)})</button>
          <button className={`ar-tab ${filter === 'issue' ? 'active' : ''}`} onClick={() => setFilter('issue')}>Issues ({num(issueN)})</button>
        </div>
      </div>

      <div className="table-card">
        {shown.length === 0
          ? <div className="table-empty" style={{ padding: 28 }}>{loading ? 'Loading…' : 'No audits yet - record one above.'}</div>
          : (
            <div className="review-list" style={{ padding: 14 }}>
              {shown.slice(pager.start, pager.end).map((a) => (
                <AuditCard key={a.id || a.at} a={a} />
              ))}
            </div>
          )}
        <Pager {...pager} total={shown.length} />
      </div>
    </>
  )
}

// ============ CARDS ============
function ReviewCard({ r, onResolve, busy }) {
  const [note, setNote] = useState('')
  const resolved = isResolved(r.status)
  const where = locationBreadcrumb(r) || r.page

  return (
    <div className={`review-card ${resolved ? 'is-resolved' : ''}`}>
      <div className="review-card-head">
        <span className="review-card-user">{r.user}</span>
        {r.role && <span className="muted" style={{ fontSize: 11.5 }}>· {r.role}</span>}
        <span className={`status-pill ${resolved ? 'status-closed' : 'status-open'}`}>{resolved ? 'Resolved' : 'Under process'}</span>
        <span className="review-card-when muted">{r.at ? new Date(r.at).toLocaleString() : ''}</span>
      </div>
      {where && <div className="review-card-loc"><span className="review-card-loc-label">Where</span>{where}</div>}
      <div className="review-card-comment">{r.comment}</div>
      {r.screenshot && <a className="review-card-shot" href={r.screenshot} target="_blank" rel="noopener noreferrer">View screenshot</a>}

      {resolved ? (
        <div className="review-card-resolved">
          Resolved{r.resolvedBy ? ` by ${r.resolvedBy}` : ''}{r.resolvedAt ? ` · ${new Date(r.resolvedAt).toLocaleDateString()}` : ''}
          {r.note ? ` - ${r.note}` : ''}
        </div>
      ) : (
        <div className="review-card-actions">
          <input className="review-note-input" placeholder="Resolution note (optional)…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={busy} onClick={() => onResolve(r, note)}>{busy ? 'Saving…' : 'Mark resolved'}</button>
        </div>
      )}
    </div>
  )
}

function AuditCard({ a }) {
  const where = locationBreadcrumb(a) || a.page
  const issue = a.verdict === 'issue'
  return (
    <div className={`review-card ${issue ? '' : 'is-audited'}`}>
      <div className="review-card-head">
        <span className="review-card-user">{a.user}</span>
        {a.role && <span className="muted" style={{ fontSize: 11.5 }}>· {a.role}</span>}
        <span className={`status-pill ${issue ? 'status-open' : 'status-audited'}`}>{issue ? 'Issue found' : 'Correct'}</span>
        <span className="review-card-when muted">{a.at ? new Date(a.at).toLocaleString() : ''}</span>
      </div>
      {where && <div className="review-card-loc"><span className="review-card-loc-label">Audited</span>{where}</div>}
      {a.comment && <div className="review-card-comment">{a.comment}</div>}
    </div>
  )
}
