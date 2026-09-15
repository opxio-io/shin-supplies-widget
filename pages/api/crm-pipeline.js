// pages/api/crm-pipeline.js
// Shin Supplies — CRM & Pipeline dashboard
// Standalone Vercel serverless function. Single-tenant (no Supabase lookup) —
// ported from opxio-api handlers/clients/shin-supplies/crm-pipeline.js.
//
// Cache strategy (fastest → slowest):
//   1. In-memory cache — HIT: return instantly, no I/O
//   2. In-flight dedup — concurrent cold-cache requests share one Notion call
//   3. Notion API — queued (max 3 concurrent), 8s timeout
//
// X-Cache header: HIT | STALE | MISS

import { cacheGet, cacheSet, cacheKey, cacheDelete } from '../../lib/cache.js'
import { notionQueue } from '../../lib/queue.js'

const NOTION_KEY   = process.env.NOTION_API_KEY
// Verified against the live workspace — these are the correct DB ids for
// Shin Supplies (the old opxio-api handler's hardcoded fallbacks pointed at
// DB ids that don't exist; it only worked because Supabase had an override).
const ENQUIRY_DB   = process.env.ENQUIRY_DB || 'cbebbbc47d4d827fa66801097f224dfc'
const PEOPLE_DB    = process.env.PEOPLE_DB  || '5ecbbbc47d4d82f9849901b44678eb75'
const WIDGET_TOKEN = process.env.WIDGET_TOKEN || null

const EXCLUDED          = ['Unassigned', 'Nurhan']
const STAGE_ORDER       = ['New Lead', 'Quotation Sent', 'Negotiation', 'Sales Order Issued', 'Closed Won', 'Closed Lost']
const NOTION_TIMEOUT_MS = 8_000

// ── In-flight deduplication ───────────────────────────────────────────────
const _inflight = new Map()

// ── Notion paginator — queued + timeout + optional filter ─────────────────
async function queryAll(dbId, filter = null) {
  const headers = {
    Authorization: `Bearer ${NOTION_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS)
    try {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      if (filter) body.filter = filter
      const d = await notionQueue.add(async () => {
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
        return r.json()
      })
      results = results.concat(d.results)
      hasMore = d.has_more
      cursor  = d.next_cursor
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

// 13-month cutoff — enough for current month + 12 months back navigation
function leadsDateFilter() {
  const d = new Date()
  d.setMonth(d.getMonth() - 13)
  d.setDate(1)
  return { property: 'Submitted At', date: { on_or_after: d.toISOString().slice(0, 10) } }
}

// ── Property getters ──────────────────────────────────────────────────────
const getTitle    = p => (p?.title        || []).map(t => t.plain_text).join('')
const getStatus   = p => p?.status?.name  || p?.select?.name || null
const getDate     = p => p?.date?.start   || null
const getCheckbox = p => p?.checkbox === true
const getRelIds   = p => (p?.relation     || []).map(r => r.id)
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)
const getFormula  = p => (p?.formula?.string ?? (p?.formula?.number != null ? String(p.formula.number) : null))

// Bucket the Lead Tier formula string into priority | average | weak (defensive: ignores wording/emoji)
function tierKey(raw) {
  if (!raw) return null
  const v = String(raw).toLowerCase()
  if (v.includes('priorit')) return 'priority'
  if (v.includes('weak'))    return 'weak'
  if (v.includes('average') || v.includes('avg')) return 'average'
  return null
}

// ── Stats computation (pure) ──────────────────────────────────────────────
function computeStats({ pages, repMap, mStart, mEnd, now }) {
  const today = now.toISOString().slice(0, 10)
  const d3    = new Date(now); d3.setDate(now.getDate() + 3)
  const d3Str = d3.toISOString().slice(0, 10)

  let monthLeads = 0, quotationsSent = 0, closedWon = 0, closedLost = 0
  let followupsToday = 0, followupsNext3 = 0, overdueResponse = 0
  const tierCount = { priority: 0, average: 0, weak: 0 }
  let daysToCloseSum = 0, daysToCloseCount = 0, quoteToWinSum = 0, quoteToWinCount = 0

  const stageCount = {}, productCount = {}, sourceCount = {}, sourceClosedCount = {}, repStats = {}

  for (const page of pages) {
    const p         = page.properties
    const status    = getStatus(p['Status'])
    const submAt    = getDate(p['Submitted At'])
    const quoIssued = getCheckbox(p['Quotation Issued'])
    const quoSentDate = getDate(p['Quotation Sent Date'])
    const closedWonDateRaw = getDate(p['Closed Won Date'])
    const nextFU    = getDate(p['Next Follow-up Date'])
    const assigned  = getRelIds(p['Assigned To'])
    const products  = getMultiSel(p['Kategori produk'])
    const source    = getStatus(p['Lead Source'])

    if (!status) continue

    const submDate = submAt ? new Date(submAt) : null
    const ageH     = submDate ? (now - submDate) / 3600000 : null
    const inMonth  = submDate && submDate >= mStart && submDate < mEnd
    const isClosed = status === 'Closed Won' || status === 'Closed Lost' || status === 'Done'
    const isWon    = status === 'Closed Won'  || status === 'Done'
    const isLost   = status === 'Closed Lost'

    // Closed Won is bucketed by the date the deal actually closed, NOT Submitted At.
    // Falls back to last_edited_time for records that predate the Closed Won Date property.
    const wonDate    = closedWonDateRaw ? new Date(closedWonDateRaw) : (isWon ? new Date(page.last_edited_time) : null)
    const wonInMonth = isWon && wonDate && wonDate >= mStart && wonDate < mEnd

    let repName = 'Unassigned'
    if (assigned.length > 0) {
      const rid     = assigned[0]
      const repInfo = repMap[rid] || repMap[rid.replace(/-/g, '')]
      if (repInfo) {
        // Only show rep in a month if they existed (were created) before that month ended
        const repCreated = repInfo.createdAt ? new Date(repInfo.createdAt) : null
        if (!repCreated || repCreated < mEnd) repName = repInfo.name
      }
    }
    if (!repStats[repName]) repStats[repName] = { closedWon: 0, closedLost: 0, activePipeline: 0, activities: 0, followupsToday: 0 }

    if (inMonth) {
      monthLeads++
      repStats[repName].activities++
      const tk = tierKey(getFormula(p['Lead Tier']))
      if (tk) tierCount[tk]++
      const stageKey = status === 'Done' ? 'Closed Won' : status
      stageCount[stageKey] = (stageCount[stageKey] || 0) + 1
      for (const prod of products) productCount[prod] = (productCount[prod] || 0) + 1
      if (source) {
        sourceCount[source] = (sourceCount[source] || 0) + 1
      }
      if (status !== 'New Lead') {
        quotationsSent++
        if (isLost) { closedLost++; repStats[repName].closedLost = (repStats[repName].closedLost || 0) + 1 }
      }
    }

    // Closed Won counted independently of submission month — by Closed Won Date instead.
    if (wonInMonth) {
      closedWon++; repStats[repName].closedWon++
      if (source) sourceClosedCount[source] = (sourceClosedCount[source] || 0) + 1
      if (submDate)    { daysToCloseSum += (wonDate - submDate) / 86400000; daysToCloseCount++ }
      if (quoSentDate) { quoteToWinSum  += (wonDate - new Date(quoSentDate)) / 86400000; quoteToWinCount++ }
    }

    if (nextFU && !isClosed) {
      if (nextFU <= today) { followupsToday++; repStats[repName].followupsToday++ }
      if (nextFU <= d3Str) followupsNext3++
    }
    if (!isClosed && !quoIssued && status === 'New Lead' && ageH !== null && ageH > 2) overdueResponse++
    if (!isClosed) repStats[repName].activePipeline++
  }

  const closeRate = quotationsSent > 0 ? Math.round((closedWon / quotationsSent) * 100) : null
  const avgDaysToClose = daysToCloseCount > 0 ? Math.round(daysToCloseSum / daysToCloseCount) : null
  const avgQuoteToWin  = quoteToWinCount  > 0 ? Math.round(quoteToWinSum  / quoteToWinCount)  : null
  const tierPct = n => monthLeads > 0 ? Math.round((n / monthLeads) * 100) : 0
  const leadTiers = {
    total: monthLeads,
    tiers: [
      { key: 'priority', label: 'Priority', count: tierCount.priority, pct: tierPct(tierCount.priority) },
      { key: 'average',  label: 'Average',  count: tierCount.average,  pct: tierPct(tierCount.average) },
      { key: 'weak',     label: 'Weak',     count: tierCount.weak,     pct: tierPct(tierCount.weak) },
    ],
  }
  const stageFunnel  = STAGE_ORDER.map(s => ({ stage: s, count: stageCount[s] || 0 }))
  const repBreakdown = Object.entries(repStats)
    .filter(([name]) => !EXCLUDED.includes(name))
    .map(([name, s]) => ({ name, closedWon: s.closedWon || 0, closedLost: s.closedLost || 0, activePipeline: s.activePipeline || 0, activities: s.activities || 0, followupsToday: s.followupsToday || 0 }))
    .sort((a, b) => b.closedWon - a.closedWon || b.activePipeline - a.activePipeline)

  return {
    monthLeads, quotationsSent, closedWon, closedLost, closeRate, avgDaysToClose, avgQuoteToWin, leadTiers,
    live: { followupsToday, followupsNext3, overdueResponse },
    stageFunnel, repBreakdown,
    productBreakdown: productCount,
    sourceBreakdown: Object.fromEntries(
      Object.entries(sourceCount).map(([src, count]) => [src, { leads: count, closed: sourceClosedCount[src] || 0 }])
    ),
  }
}

// ── Shared fetch logic (used by MISS and background STALE refresh) ────────
function buildFetchPromise(ck) {
  if (_inflight.has(ck)) return _inflight.get(ck)
  const p = Promise.all([
    queryAll(ENQUIRY_DB, leadsDateFilter()),
    queryAll(PEOPLE_DB).catch(() => []),
  ]).then(([pages, people]) => {
    const repMap = {}
    for (const person of people) {
      const nameProp = person.properties['Name'] || person.properties['Nama'] || person.properties['Full Name']
      const roleProp = person.properties['Role'] || person.properties['role'] || person.properties['Position']
      // Role must be exactly 'Sales Rep' (multi_select or select/status)
      const roleArr    = getMultiSel(roleProp)
      const roleSingle = getStatus(roleProp) || getTitle(roleProp)
      const roleNames  = roleArr.length > 0 ? roleArr : (roleSingle ? [roleSingle] : [])
      if (!roleNames.some(r => r.toLowerCase() === 'sales rep')) continue

      // Status must be exactly 'Active'
      const statusProp   = person.properties['Status'] || person.properties['Active'] || person.properties['Employment Status']
      const personStatus = getStatus(statusProp)
      if (!personStatus || personStatus.toLowerCase() !== 'active') continue

      const name      = getTitle(nameProp)
      const createdAt = person.created_time || null
      if (name) {
        const entry = { name, createdAt }
        repMap[person.id]                   = entry
        repMap[person.id.replace(/-/g, '')] = entry
      }
    }
    const fresh = { pages, repMap, total: pages.length }
    cacheSet(ck, fresh)
    return fresh
  }).finally(() => _inflight.delete(ck))
  _inflight.set(ck, p)
  return p
}

// ── Request handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!NOTION_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: NOTION_API_KEY not set' })
  }

  if (WIDGET_TOKEN) {
    const token = req.query.token || req.headers['x-widget-token']
    if (!token) return res.status(401).json({ error: 'Missing token' })
    if (token !== WIDGET_TOKEN) return res.status(403).json({ error: 'Invalid token' })
  }

  const now    = new Date()
  const qMonth = req.query.month !== undefined ? parseInt(req.query.month) : null
  const qYear  = req.query.year  !== undefined ? parseInt(req.query.year)  : null
  const mYear  = (qMonth !== null && qYear !== null && !isNaN(qMonth) && !isNaN(qYear)) ? qYear  : now.getFullYear()
  const mMon   = (qMonth !== null && qYear !== null && !isNaN(qMonth) && !isNaN(qYear)) ? qMonth : now.getMonth()
  const mStart = new Date(mYear, mMon, 1)
  const mEnd   = new Date(mYear, mMon + 1, 1)

  const ck            = cacheKey('shin-supplies:crm-pipeline')
  const forceRefresh  = req.query.force === '1'
  if (forceRefresh) cacheDelete(ck)
  const hit = forceRefresh ? null : cacheGet(ck)

  function respond(data, cacheStatus) {
    res.setHeader('X-Cache', cacheStatus)
    const stats = computeStats({ ...data, mStart, mEnd, now })
    res.status(200).json({ total: data.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })
  }

  // ── HIT ────────────────────────────────────────────────────────────────
  if (hit && !hit.stale) return respond(hit.data, 'HIT')

  // ── STALE: respond immediately, refresh in background ─────────────────
  if (hit && hit.stale) {
    respond(hit.data, 'STALE')
    buildFetchPromise(ck).catch(e => console.error('[crm-pipeline] bg refresh failed:', e.message))
    return
  }

  // ── MISS: fetch, deduplicated ──────────────────────────────────────────
  try {
    const data = await buildFetchPromise(ck)
    respond(data, 'MISS')
  } catch (e) {
    console.error('[crm-pipeline] fetch error:', e.message)
    const stale = cacheGet(ck)
    if (stale) return respond(stale.data, 'STALE')
    res.status(503).json({ error: 'Notion API unavailable and no cache exists. Try again shortly.' })
  }
}
