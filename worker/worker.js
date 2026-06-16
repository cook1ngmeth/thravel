const CATEGORIES = ['food', 'transport', 'lodging', 'activities', 'shopping', 'other']
const CURRENCIES = ['VND', 'USD', 'CAD', 'THB']
const DEFAULT_NOTEBOOK_CODE = 'SHAREDTRIP'
const EXCHANGE_CACHE_SECONDS = 60 * 60 * 24
const exchangeCache = new Map()

const CURRENCY_WORDS = {
  vnd: 'VND',
  dong: 'VND',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  cad: 'CAD',
  thb: 'THB',
  baht: 'THB',
}

const todayISO = () => new Date().toISOString().slice(0, 10)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function toError(message, status = 500) {
  return json({ error: message }, status)
}

function parseBody(request) {
  return request.json().catch(() => ({}))
}

function randomId() {
  return crypto.randomUUID()
}

function normalizeCurrency(currency, fallback = 'VND') {
  const next = String(currency || fallback).toUpperCase()
  return CURRENCIES.includes(next) ? next : fallback
}

async function fetchExchangeQuote(amount, from, to) {
  const source = normalizeCurrency(from, 'USD')
  const target = normalizeCurrency(to, 'VND')
  const value = Number(amount)
  if (!Number.isFinite(value)) throw new Error('valid amount required')

  const now = Date.now()
  const cached = exchangeCache.get(source)
  let payload = cached?.payload
  if (!payload || now - cached.timestamp > EXCHANGE_CACHE_SECONDS * 1000) {
    const response = await fetch(`https://open.er-api.com/v6/latest/${source}`)
    if (!response.ok) throw new Error('exchange rates unavailable')
    payload = await response.json()
    if (payload.result !== 'success' || !payload.rates?.[target]) {
      throw new Error('exchange rate unavailable')
    }
    exchangeCache.set(source, { timestamp: now, payload })
  }

  const rate = Number(payload.rates[target])
  return {
    amount: value,
    from: source,
    to: target,
    rate,
    converted: value * rate,
    updated_at: payload.time_last_update_utc,
    next_update_at: payload.time_next_update_utc,
    provider: payload.provider || 'https://www.exchangerate-api.com',
  }
}

function normalizeCategory(text) {
  const value = (text || '').toLowerCase()
  if (/(coffee|meal|restaurant|cafe|food|breakfast|lunch|dinner|snack|tea|drink)/.test(value)) return 'food'
  if (/(taxi|uber|bus|train|flight|plane|airline|metro|fuel|parking|car|transport)/.test(value)) return 'transport'
  if (/(hotel|stay|hostel|room|resort|lodg)/.test(value)) return 'lodging'
  if (/(ticket|museum|tour|entry|activity|show|attraction)/.test(value)) return 'activities'
  if (/(souvenir|shop|clothes|gift|toiletry|market|store)/.test(value)) return 'shopping'
  return 'other'
}

function detectCurrency(text, fallback = 'VND') {
  const lower = text.toLowerCase()
  for (const [word, currency] of Object.entries(CURRENCY_WORDS)) {
    if (lower.includes(word)) return currency
  }
  return fallback
}

function parseFallback(noteText, defaultCurrency = 'VND') {
  const notes = noteText
    .split(/[,\n;]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const parsed = []
  for (const item of notes) {
    const money = item.match(/-?\d+(?:[.,]\d{1,2})?/g)
    if (!money) continue
    const amount = Number(money[0].replace(',', '.'))
    if (Number.isNaN(amount)) continue
    const merchant = item.replace(money[0], '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim()
    parsed.push({
      amount,
      currency: detectCurrency(item, defaultCurrency),
      category: normalizeCategory(item),
      merchant: merchant || item.slice(0, 28),
      note: item,
      expense_date: todayISO(),
      confidence: 0.35,
    })
  }

  if (!parsed.length) {
    parsed.push({
      amount: 0,
      currency: defaultCurrency,
      category: 'other',
      merchant: '',
      note: noteText,
      expense_date: todayISO(),
      confidence: 0.12,
    })
  }

  return parsed
}

function coerceAiOutput(output, defaultCurrency = 'VND') {
  const items = []
  if (!output) return items

  const raw = typeof output === 'string'
    ? output
    : output.responseText || output.response || output.result || ''

  if (!raw) return items

  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return items
    const jsonBody = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(jsonBody.items)) return items
    for (const row of jsonBody.items) {
      const amount = Number(row?.amount)
      if (!Number.isFinite(amount)) continue
      items.push({
        amount,
        currency: normalizeCurrency(row.currency, defaultCurrency),
        category: normalizeCategory(row.category || row.note || row.merchant || ''),
        merchant: row.merchant || '',
        note: row.note || '',
        expense_date: row.date || todayISO(),
        confidence: row.confidence ? Number(row.confidence) : 0.85,
      })
    }
    return items
  } catch (error) {
    return items
  }
}

async function parseWithAI(env, noteText, defaultCurrency = 'VND') {
  if (!env.AI) return []
  const prompt = `
You are an expense parser. Return only JSON.
Use ${defaultCurrency} when the note has no currency.
{
  "items": [
    {
      "amount": number,
      "currency": "VND|USD|CAD|THB",
      "category": "food|transport|lodging|activities|shopping|other",
      "merchant": "short text",
      "note": "optional note",
      "date": "YYYY-MM-DD",
      "confidence": 0.0-1.0
    }
  ]
}
Parse this note:
"""${noteText}"""
`
  const models = (
    env.AI_MODEL ||
    '@cf/meta/llama-3.3-70b-instruct,@cf/meta/llama-3.1-70b-instruct,@cf/meta/llama-3-8b-instruct'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  for (const model of models) {
    try {
      const response = await env.AI.run(model, {
        prompt,
        max_tokens: 1200,
        temperature: 0.1,
      })
      const parsed = coerceAiOutput(response, defaultCurrency)
      if (parsed.length) return parsed
    } catch (error) {
      continue
    }
  }

  return []
}

async function getOrCreateDefaultNotebook(db) {
  const existing = await db.prepare('SELECT id, code FROM notebooks WHERE code = ?').bind(DEFAULT_NOTEBOOK_CODE).first()
  if (existing) return { notebookId: existing.id, code: existing.code }

  const id = randomId()
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO notebooks (id, code, created_at) VALUES (?, ?, ?)').bind(id, DEFAULT_NOTEBOOK_CODE, now).run()
  return { notebookId: id, code: DEFAULT_NOTEBOOK_CODE }
}

function shapeTrip(row) {
  if (!row) return null
  return {
    id: row.id,
    destination: row.destination || '',
    currency: row.currency || 'VND',
    status: row.status || 'active',
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function ensureDefaultTripForExistingExpenses(db, notebookId) {
  const active = await db
    .prepare('SELECT * FROM trips WHERE notebook_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .bind(notebookId, 'active')
    .first()
  if (active) return shapeTrip(active)

  const orphanCount = await db
    .prepare('SELECT COUNT(*) AS count FROM expenses WHERE notebook_id = ? AND trip_id IS NULL')
    .bind(notebookId)
    .first()

  if (!orphanCount?.count) return null

  const id = 'default-trip'
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT OR IGNORE INTO trips
       (id, notebook_id, destination, currency, status, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, notebookId, '', 'VND', 'active', now, null, now, now)
    .run()
  await db.prepare('UPDATE expenses SET trip_id = ? WHERE notebook_id = ? AND trip_id IS NULL').bind(id, notebookId).run()
  const trip = await db.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first()
  return shapeTrip(trip)
}

async function listTrips(db, notebookId) {
  const result = await db
    .prepare(
      `SELECT t.*,
        COALESCE(SUM(CASE WHEN e.currency = t.currency THEN e.amount ELSE 0 END), 0) AS total
       FROM trips t
       LEFT JOIN expenses e ON e.trip_id = t.id
       WHERE t.notebook_id = ?
       GROUP BY t.id
       ORDER BY t.status = 'active' DESC, t.started_at DESC`,
    )
    .bind(notebookId)
    .all()

  return (result.results || []).map((row) => ({ ...shapeTrip(row), total: Number(row.total || 0) }))
}

async function getTrip(db, tripId) {
  const trip = await db.prepare('SELECT * FROM trips WHERE id = ?').bind(tripId).first()
  return shapeTrip(trip)
}

async function getActiveTrip(db, notebookId) {
  await ensureDefaultTripForExistingExpenses(db, notebookId)
  const trip = await db
    .prepare('SELECT * FROM trips WHERE notebook_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .bind(notebookId, 'active')
    .first()
  return shapeTrip(trip)
}

async function listExpenses(db, tripId) {
  const result = await db
    .prepare(
      `SELECT id, trip_id, amount, currency, category, merchant, note, expense_date, source_text, confidence, created_at, updated_at
       FROM expenses
       WHERE trip_id = ?
       ORDER BY expense_date DESC, created_at DESC`,
    )
    .bind(tripId)
    .all()
  return result.results || []
}

async function insertExpense(db, notebookId, tripId, item, sourceText, defaultCurrency) {
  const id = randomId()
  const now = new Date().toISOString()
  const currency = normalizeCurrency(item.currency, defaultCurrency)
  await db
    .prepare(
      `INSERT INTO expenses
      (id, notebook_id, trip_id, amount, currency, category, merchant, note, expense_date, source_text, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      notebookId,
      tripId,
      item.amount,
      currency,
      item.category || normalizeCategory(item.note),
      item.merchant || '',
      item.note || '',
      item.expense_date || todayISO(),
      sourceText || '',
      item.confidence || 0.25,
      now,
      now,
    )
    .run()
  return {
    id,
    trip_id: tripId,
    amount: Number(item.amount),
    currency,
    category: item.category || normalizeCategory(item.note),
    merchant: item.merchant || '',
    note: item.note || '',
    expense_date: item.expense_date || todayISO(),
    source_text: sourceText || '',
    confidence: item.confidence || 0.25,
    created_at: now,
    updated_at: now,
  }
}

function pathId(path, prefix) {
  const [, id] = path.split(prefix)
  return id || ''
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      const { pathname } = url
      const db = env.DB

      if (!pathname.startsWith('/api/')) {
        if (env.ASSETS?.fetch) return env.ASSETS.fetch(request)
        return toError('Assets binding unavailable', 500)
      }

      if (pathname === '/api/exchange' && request.method === 'GET') {
        const amount = url.searchParams.get('amount') || '1'
        const from = url.searchParams.get('from') || 'USD'
        const to = url.searchParams.get('to') || 'VND'
        return json({ quote: await fetchExchangeQuote(amount, from, to) })
      }

      const notebook = await getOrCreateDefaultNotebook(db)

      if (pathname === '/api/trips' && request.method === 'GET') {
        await ensureDefaultTripForExistingExpenses(db, notebook.notebookId)
        return json({ trips: await listTrips(db, notebook.notebookId) })
      }

      if (pathname === '/api/trips/active' && request.method === 'GET') {
        return json({ trip: await getActiveTrip(db, notebook.notebookId) })
      }

      if (pathname === '/api/trips' && request.method === 'POST') {
        const body = await parseBody(request)
        const existing = await getActiveTrip(db, notebook.notebookId)
        if (existing) return json({ trip: existing })

        const id = randomId()
        const now = new Date().toISOString()
        const currency = normalizeCurrency(body.currency, 'VND')
        await db
          .prepare(
            `INSERT INTO trips
             (id, notebook_id, destination, currency, status, started_at, ended_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, notebook.notebookId, body.destination || '', currency, 'active', now, null, now, now)
          .run()
        return json({ trip: await getTrip(db, id) }, 201)
      }

      if (pathname.startsWith('/api/trips/') && pathname.endsWith('/end') && request.method === 'POST') {
        const tripId = pathId(pathname, '/api/trips/').replace('/end', '')
        const now = new Date().toISOString()
        await db.prepare('UPDATE trips SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?').bind('ended', now, now, tripId).run()
        return json({ trip: await getTrip(db, tripId) })
      }

      if (pathname.startsWith('/api/trips/') && request.method === 'PATCH') {
        const tripId = pathId(pathname, '/api/trips/')
        const body = await parseBody(request)
        const existing = await getTrip(db, tripId)
        if (!existing) return toError('trip not found', 404)

        const status = body.status === 'ended' || body.status === 'active' ? body.status : existing.status
        const now = new Date().toISOString()
        await db
          .prepare('UPDATE trips SET destination = ?, currency = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(body.destination ?? existing.destination, normalizeCurrency(body.currency, existing.currency), status, now, tripId)
          .run()
        return json({ trip: await getTrip(db, tripId) })
      }

      if (pathname === '/api/expenses' && request.method === 'GET') {
        const tripId = url.searchParams.get('tripId')
        if (!tripId) return toError('tripId required', 400)
        const trip = await getTrip(db, tripId)
        if (!trip) return toError('trip not found', 404)
        const expenses = await listExpenses(db, tripId)
        const total = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0)
        return json({ trip, expenses, total })
      }

      if (pathname === '/api/notes' && request.method === 'POST') {
        const body = await parseBody(request)
        const { tripId, noteText } = body || {}
        if (!tripId || !noteText?.trim()) return toError('tripId and noteText required', 400)

        const trip = await getTrip(db, tripId)
        if (!trip) return toError('trip not found', 404)
        if (trip.status !== 'active') return toError('trip has ended', 400)

        let parsed = await parseWithAI(env, noteText, trip.currency)
        if (!parsed.length) parsed = parseFallback(noteText, trip.currency)

        const inserted = []
        for (const item of parsed) {
          inserted.push(await insertExpense(db, notebook.notebookId, trip.id, item, noteText, trip.currency))
        }
        return json({ expenses: inserted }, 201)
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'PATCH') {
        const id = pathId(pathname, '/api/expenses/')
        const body = await parseBody(request)
        const existing = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        if (!existing) return toError('expense not found', 404)

        const now = new Date().toISOString()
        await db
          .prepare(
            `UPDATE expenses
             SET amount = ?, currency = ?, category = ?, merchant = ?, note = ?, expense_date = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            Number(body.amount),
            normalizeCurrency(body.currency, existing.currency),
            body.category || existing.category,
            body.merchant ?? existing.merchant,
            body.note ?? existing.note,
            body.expense_date || body.expenseDate || existing.expense_date,
            now,
            id,
          )
          .run()

        const updated = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        return json({ expense: updated })
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'DELETE') {
        const id = pathId(pathname, '/api/expenses/')
        await db.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run()
        return json({ ok: true })
      }

      return toError('not found', 404)
    } catch (error) {
      return toError(error?.message || 'unexpected error', 500)
    }
  },
}
