# Execution-runtime contract removal

Use this one-time controlled-maintenance procedure to remove the obsolete
execution-runtime compatibility field from the public Conversation contract and
database schema.

1. Close new-work admission with the existing frontend exposure gate.
2. Pause AgentCore Dispatch with the existing SSM control.
3. Confirm Postgres contains zero Active Runs and no live Conversation
   Ownership. Keep admission closed and Dispatch paused until both remain zero.
4. Deploy the schema migration that removes the Conversation runtime
   discriminator. Do not add or run a custom Fargate-data preflight; production
   data was already removed and Release 1 enforced the AgentCore-only invariant.
5. Roll out the coordinated API and frontend consumer versions that omit the
   obsolete response field. Do not run an older API binary against the new
   schema.
6. Verify Conversation creation, list, and lifecycle responses omit the field;
   verify a synthetic Conversation admits exactly one Dispatch and completes a
   Run through AgentCore; verify the Dispatch publisher, consumer, Runtime, and
   maintenance service are healthy.
7. Restore Dispatch through SSM, then restore new-work admission through the
   exposure gate. Monitor the synthetic flow and normal error telemetry.

If verification fails, keep admission closed and Dispatch paused, roll forward
a fix, and repeat the checks. The exposure gate and SSM Dispatch control remain
in service after this transition.
