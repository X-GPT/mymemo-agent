-- Local KB seed for the docker-compose harness (MYM-31).
--
-- The agent-worker's scoped document client reads this read-only KB schema
-- (packages/agent-worker/src/documents/) over KB_DATABASE_URL. This seed provides the
-- schema plus a small fixture so the worker's document search/load tools return
-- real results for the seeded member in local development.
--
-- Scope model:
--   workspace_id = member_code   (the X-Member-Code header chat-api forwards)
--   summaryId    = content_asset.compat_int_id  -> document.id
--   collectionId = content_collection.compat_str_id
--                  (-> compat_int_id::text mirrored in passage_collection.collection_id)
--
-- This file runs once, on first init of an empty data volume
-- (/docker-entrypoint-initdb.d). `docker compose down -v` wipes it to re-seed.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
CREATE TABLE workspace (id TEXT PRIMARY KEY);

CREATE TABLE source_asset (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  status       TEXT,
  created_at   TIMESTAMPTZ
);

CREATE TABLE document (
  id                TEXT PRIMARY KEY,
  source_asset_id   TEXT,
  workspace_id      TEXT,
  version           INTEGER,
  title             TEXT,
  source_type       TEXT,
  language          TEXT,
  canonical_markdown TEXT,
  status            TEXT,
  created_at        TIMESTAMPTZ
);

CREATE TABLE passage (
  id           TEXT PRIMARY KEY,
  document_id  TEXT,
  workspace_id TEXT,
  passage_text TEXT,
  search_tsv   TSVECTOR,
  status       TEXT
);

-- Platform compat: knowledge.id (numeric summaryId) -> KB document.id
CREATE TABLE content_asset (
  compat_int_id  BIGINT,
  member_code    TEXT,
  kb_document_id TEXT
);

-- Platform compat: named collections scoped to a workspace
CREATE TABLE content_collection (
  compat_int_id BIGINT,
  compat_str_id TEXT,
  member_code   TEXT
);

-- Many-to-many: passages in collections.
-- collection_id mirrors content_collection.compat_int_id::text
CREATE TABLE passage_collection (
  passage_id    TEXT,
  collection_id TEXT
);

-- FTS index over the precomputed tsvector + the common scope filters.
CREATE INDEX passage_search_tsv_idx ON passage USING GIN (search_tsv);
CREATE INDEX passage_workspace_idx ON passage (workspace_id);
CREATE INDEX document_workspace_idx ON document (workspace_id);
CREATE INDEX document_source_asset_version_idx
  ON document (source_asset_id, version DESC);

-- ---------------------------------------------------------------------------
-- Fixture data
--
-- Send these identity headers to chat-api so the agent's document scope resolves
-- against this data:
--   X-Member-Code: demo-member
-- For a document-scoped chat use summaryId 1001; for a collection-scoped chat use
-- collectionId "demo-collection".
-- ---------------------------------------------------------------------------
INSERT INTO workspace (id) VALUES ('demo-member');

INSERT INTO source_asset (id, workspace_id, status, created_at) VALUES
  ('asset-ml-intro', 'demo-member', 'ready', '2026-01-02T00:00:00Z'),
  ('asset-mymemo-overview', 'demo-member', 'ready', '2026-01-01T00:00:00Z');

INSERT INTO document (
  id, source_asset_id, workspace_id, version, title, source_type, language,
  canonical_markdown, status, created_at
) VALUES
  ('doc-ml-intro', 'asset-ml-intro', 'demo-member', 1, 'Intro to Machine Learning', 'markdown', 'en',
   E'# Intro to Machine Learning\n\nMachine learning is a subset of artificial intelligence that lets systems learn patterns from data instead of being explicitly programmed. Common families include supervised learning, unsupervised learning, and reinforcement learning.',
   'active', '2026-01-02T00:00:00Z'),
  ('doc-mymemo-overview', 'asset-mymemo-overview', 'demo-member', 1, 'MyMemo Overview', 'markdown', 'en',
   E'# MyMemo Overview\n\nMyMemo is a personal knowledge base. The agent answers questions by searching your documents through a scoped, read-only document client.',
   'active', '2026-01-01T00:00:00Z');

INSERT INTO passage (id, document_id, workspace_id, passage_text, search_tsv, status) VALUES
  ('psg-ml-1', 'doc-ml-intro', 'demo-member',
   'Machine learning is a subset of artificial intelligence that learns patterns from data.',
   to_tsvector('simple', 'Machine learning is a subset of artificial intelligence that learns patterns from data.'),
   'active'),
  ('psg-ml-2', 'doc-ml-intro', 'demo-member',
   'Supervised learning trains on labeled examples; unsupervised learning finds structure in unlabeled data.',
   to_tsvector('simple', 'Supervised learning trains on labeled examples; unsupervised learning finds structure in unlabeled data.'),
   'active'),
  ('psg-mymemo-1', 'doc-mymemo-overview', 'demo-member',
   'MyMemo is a personal knowledge base that answers questions by searching your documents.',
   to_tsvector('simple', 'MyMemo is a personal knowledge base that answers questions by searching your documents.'),
   'active');

-- summaryId 1001 -> doc-ml-intro (document-scoped chats)
INSERT INTO content_asset (compat_int_id, member_code, kb_document_id) VALUES
  (1001, 'demo-member', 'doc-ml-intro'),
  (1002, 'demo-member', 'doc-mymemo-overview');

-- collectionId "demo-collection" (compat_int_id 9001) groups the ML passages
INSERT INTO content_collection (compat_int_id, compat_str_id, member_code) VALUES
  (9001, 'demo-collection', 'demo-member');

INSERT INTO passage_collection (passage_id, collection_id) VALUES
  ('psg-ml-1', '9001'),
  ('psg-ml-2', '9001');
