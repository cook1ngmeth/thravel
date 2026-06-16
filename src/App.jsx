import { useEffect, useMemo, useState } from 'react'

const CURRENCIES = ['VND', 'USD', 'CAD', 'THB']
const STORAGE_CACHE_PREFIX = 'thravel:cache:'
const FX_RATE_CACHE_PREFIX = 'thravel:fx:'
const FX_TTL_MS = 24 * 60 * 60 * 1000

function currencyFormatter(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'VND',
    maximumFractionDigits: currency === 'VND' ? 0 : 2,
  }).format(amount || 0)
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function readCachedExchangeRate(currency) {
  try {
    const raw = localStorage.getItem(`${FX_RATE_CACHE_PREFIX}${currency}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.rate || !parsed?.timestamp) return null
    if (Date.now() - parsed.timestamp > FX_TTL_MS) {
      localStorage.removeItem(`${FX_RATE_CACHE_PREFIX}${currency}`)
      return null
    }
    const rate = Number(parsed.rate)
    return Number.isFinite(rate) ? rate : null
  } catch (error) {
    return null
  }
}

function writeCachedExchangeRate(currency, rate) {
  try {
    localStorage.setItem(
      `${FX_RATE_CACHE_PREFIX}${currency}`,
      JSON.stringify({ rate, timestamp: Date.now() }),
    )
  } catch (error) {}
}

function byDate(list) {
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

function totalsByCurrency(list) {
  return list.reduce((acc, item) => {
    const currency = item.currency || 'VND'
    acc[currency] = (acc[currency] || 0) + (Number(item.amount) || 0)
    return acc
  }, {})
}

function initialDraft(item) {
  return {
    note: item.note || '',
    merchant: item.merchant || '',
    category: item.category || 'other',
    amount: String(item.amount ?? ''),
    currency: item.currency || 'VND',
    expense_date: item.expense_date || new Date().toISOString().slice(0, 10),
    google_map_url: item.google_map_url || '',
  }
}

function App() {
  const [activeTrip, setActiveTrip] = useState(null)
  const [viewTrip, setViewTrip] = useState(null)
  const [trips, setTrips] = useState([])
  const [note, setNote] = useState('')
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [editingTrip, setEditingTrip] = useState(false)
  const [tripDraft, setTripDraft] = useState({ destination: '', currency: 'VND' })
  const [exchangeRates, setExchangeRates] = useState({})

  const grouped = useMemo(() => byDate(expenses), [expenses])
  const totals = useMemo(() => totalsByCurrency(expenses), [expenses])
  const primaryTotal = totals[viewTrip?.currency || 'VND'] || 0
  const estimatedVndTotal = useMemo(
    () =>
      expenses.reduce((sum, item) => {
        const amount = Number(item.amount) || 0
        if ((item.currency || 'VND') === 'VND') return sum + amount
        const rate = exchangeRates[item.currency]
        return rate ? sum + amount * rate : sum
      }, 0),
    [expenses, exchangeRates],
  )
  const hasMixedCurrency = Object.keys(totals).length > 1
  const canCapture = viewTrip?.status === 'active'

  useEffect(() => {
    boot()
  }, [])

  useEffect(() => {
    refreshExchangeRates()
  }, [expenses])

  async function boot() {
    setLoading(true)
    try {
      const active = await fetchJson('/api/trips/active')
      const nextTrip = active.trip
      setActiveTrip(nextTrip)
      setViewTrip(nextTrip)
      if (nextTrip) {
        setTripDraft({ destination: nextTrip.destination || '', currency: nextTrip.currency || 'VND' })
        hydrateCache(nextTrip.id)
        await refreshExpenses(nextTrip.id)
      }
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Cannot open Our Travel')
    } finally {
      setLoading(false)
    }
  }

  async function fetchJson(path, options) {
    const res = await fetch(path, options)
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error || 'Request failed')
    return data
  }

  function hydrateCache(tripId) {
    const cached = localStorage.getItem(`${STORAGE_CACHE_PREFIX}${tripId}`)
    if (!cached) return
    try {
      setExpenses(JSON.parse(cached))
    } catch (error) {}
  }

  async function refreshTrips() {
    const data = await fetchJson('/api/trips')
    setTrips(data.trips || [])
  }

  async function refreshExpenses(tripId = viewTrip?.id) {
    if (!tripId) {
      setExpenses([])
      return
    }
    const data = await fetchJson(`/api/expenses?tripId=${encodeURIComponent(tripId)}`)
    setExpenses(data.expenses || [])
    localStorage.setItem(`${STORAGE_CACHE_PREFIX}${tripId}`, JSON.stringify(data.expenses || []))
  }

  async function startTrip() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency: 'VND' }),
      })
      setActiveTrip(data.trip)
      setViewTrip(data.trip)
      setTripDraft({ destination: data.trip.destination || '', currency: data.trip.currency || 'VND' })
      setExpenses([])
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not start trip')
    } finally {
      setLoading(false)
    }
  }

  async function endTrip() {
    if (!activeTrip) return
    setLoading(true)
    setError('')
    try {
      await fetchJson(`/api/trips/${activeTrip.id}/end`, { method: 'POST' })
      setActiveTrip(null)
      setViewTrip(null)
      setExpenses([])
      setEditingTrip(false)
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not end trip')
    } finally {
      setLoading(false)
    }
  }

  async function restoreTrip(trip = viewTrip) {
    if (!trip?.id) return
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson(`/api/trips/${trip.id}/restore`, { method: 'POST' })
      setActiveTrip(data.trip)
      setViewTrip(data.trip)
      setTripDraft({ destination: data.trip.destination || '', currency: data.trip.currency || 'VND' })
      setEditingTrip(false)
      hydrateCache(data.trip.id)
      await refreshExpenses(data.trip.id)
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not resume trip')
    } finally {
      setLoading(false)
    }
  }

  async function openTrip(trip) {
    setViewTrip(trip)
    setTripDraft({ destination: trip.destination || '', currency: trip.currency || 'VND' })
    setEditingTrip(false)
    hydrateCache(trip.id)
    await refreshExpenses(trip.id)
  }

  async function saveTrip() {
    if (!viewTrip) return
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson(`/api/trips/${viewTrip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tripDraft),
      })
      setViewTrip(data.trip)
      if (data.trip.status === 'active') setActiveTrip(data.trip)
      setEditingTrip(false)
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not update trip')
    } finally {
      setLoading(false)
    }
  }

  async function saveNote() {
    if (!note.trim() || !viewTrip?.id || !canCapture) return
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: viewTrip.id, noteText: note.trim() }),
      })
      const next = [...data.expenses, ...expenses]
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${viewTrip.id}`, JSON.stringify(next))
      setNote('')
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not save note')
    } finally {
      setLoading(false)
    }
  }

  function startEdit(expense) {
    setEditingId(expense.id)
    setEditDraft(initialDraft(expense))
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft(null)
  }

  async function saveEdit() {
    if (!editingId || !editDraft) return
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson(`/api/expenses/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editDraft,
          amount: Number(editDraft.amount),
          google_map_url: editDraft.google_map_url || null,
        }),
      })
      const next = expenses.map((item) => (item.id === editingId ? data.expense : item))
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${viewTrip.id}`, JSON.stringify(next))
      setEditingId(null)
      setEditDraft(null)
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not update item')
    } finally {
      setLoading(false)
    }
  }

  async function removeExpense(id) {
    setError('')
    try {
      await fetchJson(`/api/expenses/${id}`, { method: 'DELETE' })
      const next = expenses.filter((item) => item.id !== id)
      setExpenses(next)
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${viewTrip.id}`, JSON.stringify(next))
      await refreshTrips()
    } catch (err) {
      setError(err.message || 'Could not delete item')
    }
  }

  async function refreshExchangeRates() {
    const needed = [...new Set(expenses.map((item) => item.currency).filter((currency) => currency && currency !== 'VND'))]
    const fromCache = {}
    const missing = []

    needed.forEach((currency) => {
      if (exchangeRates[currency]) return
      const cachedRate = readCachedExchangeRate(currency)
      if (cachedRate) {
        fromCache[currency] = cachedRate
      } else {
        missing.push(currency)
      }
    })

    if (Object.keys(fromCache).length) {
      setExchangeRates((prev) => ({ ...prev, ...fromCache }))
    }

    if (!missing.length) return

    try {
      const quotes = await Promise.all(
        missing.map(async (currency) => {
          const data = await fetchJson(`/api/exchange?amount=1&from=${currency}&to=VND`)
          writeCachedExchangeRate(currency, data.quote.rate)
          return [currency, data.quote.rate]
        }),
      )
      setExchangeRates((prev) => ({ ...prev, ...Object.fromEntries(quotes) }))
    } catch (err) {
      // Exchange rates are optional context; expense capture should stay quiet if they fail.
    }
  }

  return (
    <main className="app-shell">
      <header className="top trip-header">
        <div>
          <h1>Our Travel</h1>
          <p>{viewTrip ? viewTrip.destination || 'Untitled trip' : 'Start a clean trip log'}</p>
        </div>
        {viewTrip ? (
          <div className="header-total">
            <span>{viewTrip.status}</span>
            <strong>{currencyFormatter(primaryTotal, viewTrip.currency)}</strong>
            {estimatedVndTotal ? <small>{currencyFormatter(estimatedVndTotal, 'VND')}</small> : null}
          </div>
        ) : null}
      </header>

      {!viewTrip ? (
        <>
          <section className="card start-card">
            <button className="primary" onClick={startTrip} disabled={loading}>
              Start trip
            </button>
          </section>
          {trips.length ? <Archive trips={trips} openTrip={openTrip} elevated /> : null}
        </>
      ) : (
        <>
          <section className="card trip-card">
            <div className="trip-toolbar">
              {editingTrip ? (
                <div className="trip-edit">
                  <input
                    value={tripDraft.destination}
                    placeholder="Destination"
                    onChange={(event) => setTripDraft((prev) => ({ ...prev, destination: event.target.value }))}
                  />
                  <select
                    value={tripDraft.currency}
                    onChange={(event) => setTripDraft((prev) => ({ ...prev, currency: event.target.value }))}
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                  <button className="quiet" onClick={saveTrip}>save</button>
                  <button className="quiet" onClick={() => setEditingTrip(false)}>cancel</button>
                </div>
              ) : (
                <>
                  <div>
                    <span className="eyebrow">destination</span>
                    <strong>{viewTrip.destination || 'Untitled trip'}</strong>
                  </div>
                  <div className="toolbar-actions">
                    <span className="currency-chip">{viewTrip.currency}</span>
                    <button className="quiet" onClick={() => setEditingTrip(true)}>edit</button>
                    {activeTrip?.id === viewTrip.id ? (
                      <button className="quiet danger" onClick={endTrip}>end</button>
                    ) : viewTrip.status === 'ended' ? (
                      <button className="quiet" onClick={() => restoreTrip(viewTrip)}>resume</button>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            {canCapture ? (
              <>
                <label className="field">
                  <span>add a note</span>
                  <textarea
                    placeholder={`Coffee 80000, taxi 220000, hotel 1200000`}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button className="primary" onClick={saveNote} disabled={loading || !note.trim()}>
                  Save
                </button>
              </>
            ) : (
              <div className="ended-strip">
                <span>Ended trip</span>
              </div>
            )}

            {hasMixedCurrency ? (
              <div className="breakdown">
                {Object.entries(totals).map(([currency, amount]) => (
                  <span key={currency}>{currencyFormatter(amount, currency)}</span>
                ))}
              </div>
            ) : null}
          </section>

          {error ? <p className="error">{error}</p> : null}

          <section className="list">
            {Object.entries(grouped).map(([date, rows]) => (
              <article key={date} className="day-card">
                <h2>{formatDay(date)}</h2>
                <div className="ledger-head">
                  <span className="thumb-head" />
                  <span>Name</span>
                  <span>Amount</span>
                </div>
                {rows.map((expense) => (
                  <ExpenseRow
                    key={expense.id}
                    expense={expense}
                    editing={editingId === expense.id}
                    editDraft={editDraft}
                    setEditDraft={setEditDraft}
                    startEdit={startEdit}
                    cancelEdit={cancelEdit}
                    saveEdit={saveEdit}
                    removeExpense={removeExpense}
                    exchangeRates={exchangeRates}
                  />
                ))}
              </article>
            ))}
            {expenses.length === 0 ? <p className="muted">No expenses yet.</p> : null}
          </section>

          <Archive trips={trips.filter((trip) => trip.id !== viewTrip.id)} openTrip={openTrip} />
        </>
      )}
    </main>
  )
}

function ExpenseRow({
  expense,
  editing,
  editDraft,
  setEditDraft,
  startEdit,
  cancelEdit,
  saveEdit,
  removeExpense,
  exchangeRates,
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const name = expense.merchant || expense.note || 'expense'
  const showNote = expense.note && expense.note !== name
  const vndRate = expense.currency === 'VND' ? null : exchangeRates[expense.currency]
  const hasMapUrl = Boolean(expense.google_map_url)
  const showThumbnail = Boolean(expense.thumbnail_url) && !thumbnailFailed
  const mapUrl = expense.google_map_url || ''

  if (editing) {
    return (
      <div className="entry ledger-row-edit">
        <div className="edit-inline">
          <label>
            <span>Name</span>
            <input
              value={editDraft.merchant}
              placeholder="Name"
              onChange={(event) => setEditDraft((prev) => ({ ...prev, merchant: event.target.value }))}
            />
          </label>
          <label>
            <span>Category</span>
            <input
              value={editDraft.category}
              onChange={(event) => setEditDraft((prev) => ({ ...prev, category: event.target.value }))}
            />
          </label>
          <label>
            <span>Date</span>
            <input
              value={editDraft.expense_date}
              onChange={(event) => setEditDraft((prev) => ({ ...prev, expense_date: event.target.value }))}
              type="date"
            />
          </label>
          <label>
            <span>Amount</span>
            <div className="inline">
              <input
                value={editDraft.amount}
                inputMode="decimal"
                onChange={(event) => setEditDraft((prev) => ({ ...prev, amount: event.target.value }))}
              />
              <select
                value={editDraft.currency}
                onChange={(event) => setEditDraft((prev) => ({ ...prev, currency: event.target.value }))}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="edit-note">
            <span>Note</span>
            <input
              value={editDraft.note}
              placeholder="Optional"
              onChange={(event) => setEditDraft((prev) => ({ ...prev, note: event.target.value }))}
            />
          </label>
          <label className="edit-note">
            <span>Google Maps URL</span>
            <input
              value={editDraft.google_map_url}
              placeholder="https://maps.google.com/..."
              onChange={(event) => setEditDraft((prev) => ({ ...prev, google_map_url: event.target.value }))}
            />
          </label>
          <div className="actions">
            <button className="quiet" onClick={saveEdit}>
              save
            </button>
            <button className="quiet" onClick={cancelEdit}>
              cancel
            </button>
            <button className="quiet danger" onClick={() => removeExpense(expense.id)}>
              remove
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="entry ledger-row row-open-trigger"
      onClick={() => startEdit(expense)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          startEdit(expense)
        }
      }}
      aria-label={`Edit ${name}`}
    >
      <div className="left-track">
        {hasMapUrl ? (
          <a
            className="thumb-wrap"
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
              }
            }}
            aria-label={expense.merchant ? `Open ${expense.merchant} on maps` : 'Open map'}
          >
            {showThumbnail ? (
              <img
                src={expense.thumbnail_url}
                alt="Map"
                loading="lazy"
                onError={() => setThumbnailFailed(true)}
              />
            ) : (
              <span className="pin-mark" aria-hidden="true" />
            )}
          </a>
        ) : (
          <span className="thumb-wrap thumb-wrap-empty">
            <span className="pin-mark" aria-hidden="true" />
          </span>
        )}
      </div>

      <div className="left-row-content">
        <span className="merchant">{name}</span>
        <span className="ledger-category row-category">{expense.category || 'other'}</span>
        {showNote ? <span className="muted">{expense.note}</span> : null}
      </div>

      <div className="right">
        <span>{currencyFormatter(expense.amount, expense.currency)}</span>
        {vndRate ? (
          <small>{currencyFormatter(Number(expense.amount || 0) * vndRate, 'VND')}</small>
        ) : null}
        <span className="edit-indicator" aria-hidden="true">
          &rsaquo;
        </span>
      </div>
    </div>
  )
}

function Archive({ trips, openTrip, elevated = false }) {
  if (!trips.length) return null

  return (
    <section className={elevated ? 'archive archive-card card' : 'archive'}>
      <h2>Previous trips</h2>
      {trips.map((trip) => (
        <button className="archive-row" key={trip.id} onClick={() => openTrip(trip)}>
          <span>{trip.destination || 'Untitled trip'}</span>
          <small>
            {trip.currency} - {trip.status === 'active' ? 'active' : 'ended'}
          </small>
        </button>
      ))}
    </section>
  )
}

export default App

