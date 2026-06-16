CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'THB',
  category TEXT NOT NULL,
  merchant TEXT,
  note TEXT,
  expense_date TEXT NOT NULL,
  source_text TEXT,
  confidence REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expenses_notebook_date
  ON expenses(notebook_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_notebook_category
  ON expenses(notebook_id, category);
