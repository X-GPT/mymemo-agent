# Separate document inventory from passage search

Status: accepted

Add `ListDocuments` as the model-facing operation for counting and browsing the
searchable-document inventory within a conversation's frozen scope; keep
`SearchDocuments` focused on passage relevance and `LoadDocuments` focused on
materializing selected content. Overloading passage search with an empty or
synthetic query would blur an exact inventory question with bounded retrieval
results. The inventory counts logical searchable documents once per source
asset, selects the highest active indexed version, returns an exact total plus
a bounded newest-first page, and paginates with an opaque cursor over the
source asset's stable creation time and id.

## Consequences

- `ListDocuments` returns the current version's document id, title, source type,
  language, and logical creation time so its results feed `LoadDocuments`
  directly. V1 has no metadata filters.
- All three document tools enforce the same frozen scope and highest-active-
  version rule. Collection membership requires an active passage in the
  collection, matching search and load authorization.
- Document-access audit rows distinguish `search`, `list`, and `load` and record
  the operation's result count. Durable client tool events expose only bounded,
  client-safe inventory summaries; document ids and pagination cursors remain
  internal.
- Editable workspace documents are not searchable documents and never appear
  in these tools.
