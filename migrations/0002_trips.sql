CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'VND',
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
);

ALTER TABLE expenses ADD COLUMN trip_id TEXT;

CREATE INDEX IF NOT EXISTS idx_trips_notebook_status
  ON trips(notebook_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_trip_date
  ON expenses(trip_id, expense_date DESC);

INSERT OR IGNORE INTO trips (
  id,
  notebook_id,
  destination,
  currency,
  status,
  started_at,
  ended_at,
  created_at,
  updated_at
)
SELECT
  'default-trip',
  id,
  '',
  'VND',
  'active',
  created_at,
  NULL,
  created_at,
  created_at
FROM notebooks
WHERE code = 'SHAREDTRIP'
LIMIT 1;

UPDATE expenses
SET trip_id = 'default-trip'
WHERE trip_id IS NULL
  AND notebook_id = (SELECT id FROM notebooks WHERE code = 'SHAREDTRIP' LIMIT 1);
