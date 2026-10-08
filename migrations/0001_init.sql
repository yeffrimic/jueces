-- Esquema inicial
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scale_max   INTEGER NOT NULL DEFAULT 10,
  open        INTEGER NOT NULL DEFAULT 1,
  criteria    TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);

CREATE TABLE judges (
  token      TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_judges_event ON judges(event_id);

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  team            TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_event ON projects(event_id);

CREATE TABLE scores (
  judge_token TEXT NOT NULL REFERENCES judges(token) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  scores      TEXT NOT NULL,
  feedback    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (judge_token, project_id)
);
CREATE INDEX idx_scores_event ON scores(event_id);

CREATE TABLE login_attempts (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
