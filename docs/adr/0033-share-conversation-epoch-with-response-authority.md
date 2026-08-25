# Share the Conversation epoch with Run-free Response authority

Status: accepted

ADR-0015 introduced the Conversation epoch and deadline as the durable fence
for Run execution. The replacement AI SDK Agent-query path also executes Claude
and Tools and mutates Conversation-scoped SessionStore and Workspace state, but
it deliberately has no Run or durable Run/audit identity. Fabricating a Run to
borrow Conversation Ownership would make the audit record false; giving this
path an independent fence would permit two execution authorities to overlap.

We therefore use `conversations.epoch` as the monotonic Conversation epoch for
both kinds of execution-authority grant. Durable acquisition grants Conversation
Ownership for a Run. Direct-response admission grants Run-free Response
authority. Both advance the epoch, use the database-authored
`owner_until` deadline, and require `(conversation_id, epoch, owner_until >
now())` for every execution mutation. `owner_worker_id` remains provenance and
has no safety weight.

Direct-response admission locks the authorized Conversation row, rejects any
still-live deadline before new-work side effects, advances the epoch, stores its
Response deadline, clears any stale stream pointer, and appends the User message
in one transaction. After Redis initializes the resumable stream, Chat API
publishes its pointer only while the same epoch/deadline remains live.
Successful completion atomically persists the Assistant message and
Agent-session pointer and conditionally clears the matching authority.
Archive and Permanent deletion reject either live authority; rename does not.

Response authority does not adopt Run lifecycle semantics. Producer death
leaves no retry, Reclamation, or Run debt: writes stop at the last confirmed
Response deadline, after which a later admission may advance the epoch. The
Agent-query path remains outside production composition until the hard swap.

## Considered options

- **Fabricate a Run for each direct response.** Rejected because this path has
  no durable Run/audit identity and must not invent one.
- **Add separate response epoch/deadline columns.** Rejected because two
  independently live authorities could mutate one Conversation concurrently.

## Consequences

- ADR-0015's statements that every epoch names a Claim or Durable acquisition
  now apply only when the grant is Conversation Ownership; the shared column is
  the broader Conversation epoch.
- Run-fenced helpers continue to require Conversation Ownership. New
  response-fenced helpers require matching live Response authority; the two
  grants never overlap because admission serializes on the same row/deadline.
- `agent_sessions.epoch` records either grant's provenance while transcript
  reads remain cumulative across Conversation epochs.
