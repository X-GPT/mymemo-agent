# Chat surface

`apps/agent-front` serves `/v1/conversations` through a streaming IAM Function
URL. The trusted caller supplies member, partner and optional team identity.
Scope is frozen at creation. Statsig gates creation and `send`, failing closed.

The eight routes create/list/rename/archive/delete Conversations, send/read
messages, and list/download Artifacts. `POST /:id/messages` streams AI SDK
UIMessage chunks; `GET /:id/messages` reads whole Turns with cursor paging.
A processing Turn exposes its user message and processing status only.
After a broken connection, reload history; never automatically resend.

A second send during processing returns 409. Request ids distinguish a
duplicate request from conflicting text. Archive refuses new Turns;
Permanent deletion writes a Tombstone and hides all routes immediately.
The scheduled Cleanup sweep deletes the four S3 namespaces and DynamoDB
partition, Tombstone last. Follow the front's route and store tests when
changing these contracts. See [the front runbook](../runbooks/agent-front.md).
