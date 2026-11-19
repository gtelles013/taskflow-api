CREATE TABLE {{schema}}.tasks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  title text NOT NULL
    CONSTRAINT tasks_title_length CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 120),
  description text
    CONSTRAINT tasks_description_length CHECK (description IS NULL OR pg_catalog.char_length(description) <= 500),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT tasks_status_pending CHECK (status = 'pending'),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
