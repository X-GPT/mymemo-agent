# Database and concurrency

The front owns one DynamoDB table: Conversation `META` plus `REQ#` items.
Admission uses a conditional transaction to enforce single flight and request
id uniqueness. Clearing processing is conditional on the Turn id so an older
Turn cannot clear a newer one. Permanent deletion writes a Tombstone; cleanup
removes partition items only after S3 deletion succeeds, Tombstone last.

Run the store tests against DynamoDB Local for conditional-write and cleanup
behavior. The KB Postgres is read-only and owned by mymemo-service; document
tools must apply the frozen Scope to every query. This repository owns no
writable Postgres schema or migrations.
