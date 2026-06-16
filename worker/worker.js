const CATEGORIES = [
  'food',
  'transport',
  'lodging',
  'activities',
  'shopping',
  'other',
]

const CURRENCY_SYMBOLS = {
  usd: 'USD',
  eur: 'EUR',
  sgd: 'SGD',
  thb: 'THB',
  baht: 'THB',
  usd$: 'USD',
  eur$: 'EUR',
  sgd$: 'SGD',
  '฿': 'THB',
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

function randomCode() {
  const parts = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(parts)
    .map((item) => item.toString(36))
    .join('')
    .slice(0, 8)
    .toUpperCase()
}

function normalizeCategory(text) {
  const value = (text || '').toLowerCase()
  if (/(coffee|meal|restaurant|cafe|food|breakfast|lunch|dinner|snack|tea|drink)/.test(value)) return 'food'
  if (/(taxi|uber|bus|train|flight|plane|airline|hotel|hostel|lodg|flight|metro|fuel|parking|car|transport)/.test(value))
    return 'transport'
  if (/(hotel|stay|hostel|room|resort)/.test(value)) return 'lodging'
  if (/(ticket|museum|tour|entry|activity|show|attraction)/.test(value)) return 'activities'
  if (/(souvenir|shop|clothes|gift|toiletry|market|store)/.test(value)) return 'shopping'
  return 'other'
}

function parseFallback(noteText) {
  const today = todayISO()
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
    const lower = item.toLowerCase()
    const currencyMatch = Object.entries(CURRENCY_SYMBOLS).find(([key]) =>
      lower.includes(` ${key} `) || lower.startsWith(`${key} `) || lower.endsWith(` ${key}`) || lower.includes(key)
    )
    const currency = currencyMatch ? currencyMatch[1] : 'THB'
    const merchant = item.replace(money[0], '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim()
    parsed.push({
      amount,
      currency,
      category: normalizeCategory(item),
      merchant: merchant || item.slice(0, 28),
      note: item,
      expense_date: today,
      confidence: 0.35,
    })
  }

  if (!parsed.length) {
    parsed.push({
      amount: 0,
      currency: 'THB',
      category: 'other',
      merchant: '',
      note: noteText,
      expense_date: today,
      confidence: 0.12,
    })
  }

  return parsed
}

function coerceAiOutput(output) {
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
        currency: (row.currency || 'THB').toUpperCase(),
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

async function parseWithAI(env, noteText) {
  if (!env.AI) return []
  const prompt = `
You are an expense parser. Return only JSON.
{
  "items": [
    {
      "amount": number,
      "currency": "THB|USD|EUR|SGD",
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
      const parsed = coerceAiOutput(response)
      if (parsed.length) return parsed
    } catch (error) {
      if (error?.message?.includes('5028')) {
        continue
      }
      continue
    }
  }

  return []
}

async function getNotebook(db, notebookId, code) {
  if (notebookId) {
    const found = await db.prepare('SELECT id, code FROM notebooks WHERE id = ?').bind(notebookId).first()
    if (found) return { notebookId: found.id, syncCode: found.code }
  }
  if (code) {
    const found = await db.prepare('SELECT id, code FROM notebooks WHERE code = ?').bind(code).first()
    if (found) return { notebookId: found.id, syncCode: found.code }
  }
  return null
}

async function listExpenses(db, notebookId) {
  const result = await db
    .prepare(
      `SELECT id, amount, currency, category, merchant, note, expense_date, source_text, confidence, created_at, updated_at
       FROM expenses
       WHERE notebook_id = ?
       ORDER BY expense_date DESC, created_at DESC`,
    )
    .bind(notebookId)
    .all()
  return result.results || []
}

async function insertExpense(db, notebookId, item, sourceText) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO expenses
      (id, notebook_id, amount, currency, category, merchant, note, expense_date, source_text, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      notebookId,
      item.amount,
      item.currency || 'THB',
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
    amount: Number(item.amount),
    currency: item.currency || 'THB',
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

function clampExpenseId(path) {
  const [, id] = path.split('/api/expenses/')
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

      if (pathname === '/api/notebooks' && request.method === 'POST') {
        const now = new Date().toISOString()
        const id = crypto.randomUUID()
        const syncCode = randomCode()
        await db.prepare('INSERT INTO notebooks (id, code, created_at) VALUES (?, ?, ?)').bind(id, syncCode, now).run()
        return json({ notebookId: id, syncCode })
      }

      if (pathname === '/api/notebooks' && request.method === 'GET') {
        const code = url.searchParams.get('code')
        if (!code) return toError('code required', 400)
        const notebook = await getNotebook(db, null, code.toUpperCase())
        if (!notebook) return toError('notebook not found', 404)
        return json(notebook)
      }

      if (pathname === '/api/expenses' && request.method === 'GET') {
        const notebookId = url.searchParams.get('notebookId')
        if (!notebookId) return toError('notebookId required', 400)
        const resolved = await getNotebook(db, notebookId)
        if (!resolved) return toError('notebook not found', 404)
        const expenses = await listExpenses(db, resolved.notebookId)
        const total = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0)
        return json({ notebookId: resolved.notebookId, syncCode: resolved.syncCode, expenses, total })
      }

      if (pathname === '/api/notes' && request.method === 'POST') {
        const body = await parseBody(request)
        const { notebookId, noteText } = body || {}
        if (!notebookId || !noteText?.trim()) return toError('notebookId and noteText required', 400)

        const resolved = await getNotebook(db, notebookId)
        if (!resolved) return toError('notebook not found', 404)

        let parsed = await parseWithAI(env, noteText)
        if (!parsed.length) parsed = parseFallback(noteText)
        if (!parsed.length) return toError('No expense parsed', 400)

        const inserted = []
        for (const item of parsed) {
          inserted.push(await insertExpense(db, resolved.notebookId, item, noteText))
        }
        return json({ expenses: inserted }, 201)
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'PATCH') {
        const id = clampExpenseId(pathname)
        if (!id) return toError('expense id required', 400)
        const body = await parseBody(request)
        const existing = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        if (!existing) return toError('expense not found', 404)

        const now = new Date().toISOString()
        const amount = Number(body.amount)
        const currency = body.currency || existing.currency
        const category = body.category || existing.category
        const merchant = body.merchant ?? existing.merchant
        const note = body.note ?? existing.note
        const expenseDate = body.expense_date || body.expenseDate || existing.expense_date
        await db
          .prepare(
            `UPDATE expenses
             SET amount = ?, currency = ?, category = ?, merchant = ?, note = ?, expense_date = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(amount, currency, category, merchant, note, expenseDate, now, id)
          .run()

        const updated = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        return json({ expense: updated })
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'DELETE') {
        const id = clampExpenseId(pathname)
        if (!id) return toError('expense id required', 400)
        await db.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run()
        return json({ ok: true })
      }

      return toError('not found', 404)
    } catch (error) {
      return toError(error?.message || 'unexpected error', 500)
    }
  },
}
