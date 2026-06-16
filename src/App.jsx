import { useEffect, useMemo, useState } from 'react'

const STORAGE_CACHE_PREFIX = 'thravel:cache:'

function currencyFormatter(amount, currency) {
  const locale = 'en-US'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency || 'THB',
    maximumFractionDigits: 2,
  }).format(amount)
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function byDateThenCategory(list) {
  return list
    .slice()
    .sort((a, b) => b.expense_date.localeCompare(a.expense_date))
    .reduce((acc, item) => {
      const key = item.expense_date
      if (!acc[key]) acc[key] = []
      acc[key].push(item)
      return acc
    }, {})
}

function initialDraft(item) {
  return {
    note: item.note || '',
    merchant: item.merchant || '',
    category: item.category || 'other',
    amount: String(item.amount ?? ''),
    currency: item.currency || 'THB',
    expense_date: item.expense_date || new Date().toISOString().slice(0, 10),
  }
}

function App() {
  const [notebook, setNotebook] = useState(null)
  const [note, setNote] = useState('')
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)

  const grouped = useMemo(() => byDateThenCategory(expenses), [expenses])
  const total = useMemo(() => expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0), [expenses])

  useEffect(() => {
    openSharedTrip()
  }, [])

  async function hydrateCache(notebookId) {
    const cacheKey = `${STORAGE_CACHE_PREFIX}${notebookId}`
    const cached = localStorage.getItem(cacheKey)
    if (!cached) return
    try {
      setExpenses(JSON.parse(cached))
    } catch (error) {}
  }

  async function openSharedTrip() {
    try {
      setLoading(true)
      const res = await fetch('/api/notebooks/default')
      const next = await res.json()
      if (!res.ok) throw new Error(next?.error || 'Unable to open trip.')
      setNotebook(next)
      hydrateCache(next.notebookId)
      await refreshExpenses(next.notebookId)
    } catch (err) {
      setError(err.message || 'Cannot open trip')
    } finally {
      setLoading(false)
    }
  }

  async function refreshExpenses(notebookId = notebook?.notebookId) {
    if (!notebookId) return
    try {
      const res = await fetch(`/api/expenses?notebookId=${encodeURIComponent(notebookId)}`)
      if (!res.ok) throw new Error('Could not load expenses.')
      const data = await res.json()
      setExpenses(data.expenses || [])
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${notebookId}`, JSON.stringify(data.expenses || []))
    } catch (err) {
      setError(err.message || 'Could not load expenses.')
    }
  }

  async function saveNote() {
    if (!note.trim() || !notebook?.notebookId) return
    try {
      setLoading(true)
      setError('')
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookId: notebook.notebookId, noteText: note.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Parse failed.')
      const next = [...data.expenses, ...expenses]
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${notebook.notebookId}`, JSON.stringify(next))
      setNote('')
    } catch (err) {
      setError(err.message || 'Could not save note.')
    } finally {
      setLoading(false)
    }
  }

  async function startEdit(expense) {
    setEditingId(expense.id)
    setEditDraft(initialDraft(expense))
  }

  async function cancelEdit() {
    setEditingId(null)
    setEditDraft(null)
  }

  async function saveEdit() {
    if (!editingId || !editDraft) return
    try {
      setLoading(true)
      const payload = {
        ...editDraft,
        amount: Number(editDraft.amount),
      }
      const res = await fetch(`/api/expenses/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Update failed')

      const next = expenses.map((item) => (item.id === editingId ? data.expense : item))
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${notebook.notebookId}`, JSON.stringify(next))
      setEditingId(null)
      setEditDraft(null)
    } catch (err) {
      setError(err.message || 'Could not update item.')
    } finally {
      setLoading(false)
    }
  }

  async function removeExpense(id) {
    try {
      const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Delete failed')
      const next = expenses.filter((item) => item.id !== id)
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${notebook.notebookId}`, JSON.stringify(next))
    } catch (err) {
      setError(err.message || 'Could not delete item.')
    }
  }

  return (
    <main className="app-shell">
      <header className="top">
        <h1>thravel</h1>
        <p>One shared trip log for everyone using this link</p>
      </header>

      <section className="card unified-card">
        <div className="hero-row">
          <div className="hero-copy">
            <span className="eyebrow">shared trip</span>
            <strong>Everyone here sees the same log</strong>
            <p className="support-copy">Add a note and it shows up for anyone opening this trip.</p>
          </div>
          <div className="total-tile">
            <span className="eyebrow">trip total</span>
            <strong>{currencyFormatter(total, 'THB')}</strong>
          </div>
        </div>

        <label className="field">
          <span>add a note</span>
          <textarea
            placeholder="Coffee 80 baht, taxi 220, hotel 1200"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <div className="stack-actions">
          <button className="primary" onClick={saveNote} disabled={loading}>
            save note
          </button>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="list">
        {Object.entries(grouped).map(([date, rows]) => (
          <article key={date} className="day-card">
            <h2>{formatDay(date)}</h2>
            {rows.map((expense) => (
              <div key={expense.id} className="entry">
                {editingId === expense.id ? (
                  <div className="edit-inline">
                    <input
                      value={editDraft.note}
                      onChange={(event) => setEditDraft((prev) => ({ ...prev, note: event.target.value }))}
                    />
                    <div className="inline">
                      <input
                        value={editDraft.amount}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, amount: event.target.value }))
                        }
                      />
                      <input
                        value={editDraft.category}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, category: event.target.value }))
                        }
                      />
                    </div>
                    <input
                      value={editDraft.expense_date}
                      onChange={(event) =>
                        setEditDraft((prev) => ({ ...prev, expense_date: event.target.value }))
                      }
                      type="date"
                    />
                    <div className="actions">
                      <button onClick={saveEdit}>save</button>
                      <button onClick={cancelEdit}>cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="left">
                      <span className="merchant">
                        {expense.merchant || expense.note || 'expense'}
                      </span>
                      <span className="muted">{expense.category || 'other'}</span>
                    </div>
                    <div className="right">
                      <span>{currencyFormatter(expense.amount, expense.currency)}</span>
                      <div className="row-actions">
                        <button onClick={() => startEdit(expense)}>edit</button>
                        <button onClick={() => removeExpense(expense.id)}>remove</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </article>
        ))}
        {expenses.length === 0 ? <p className="muted">No expenses yet. Add your first note above.</p> : null}
      </section>
    </main>
  )
}

export default App

