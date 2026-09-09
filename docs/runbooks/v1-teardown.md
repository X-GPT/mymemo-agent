# Completed v1 teardown (#765)

The one-time teardown completed on 2026-09-09. Its script, plan checker,
regression test and resource manifest have been removed. No teardown step
is required before normal Release deploy runs.

- [PR #766](https://github.com/X-GPT/mymemo-agent/pull/766) removed the v1
  applications, packages and infrastructure, temporarily retaining two security
  groups until AgentCore released their network interfaces.
- The retired prototype/dispatch subnets, unattached Lambda interfaces and
  empty development artifact bucket were cleaned up. Retired secrets and the
  KMS key were scheduled for deletion using their recovery/waiting periods.
- [PR #769](https://github.com/X-GPT/mymemo-agent/pull/769) removed the last two
  security groups after the old ENIs disappeared. The
  [final release](https://github.com/X-GPT/mymemo-agent/actions/runs/34320762222)
  succeeded with zero creates, two updates and two deletes.
- Live inventory and Terraform state confirmed no retired v1 resources remained
  managed. A real Function URL Turn completed at 06:53 UTC with a successful
  ListDocuments result and persisted reply. The smoke Conversation was deleted.

[Issue #765](https://github.com/X-GPT/mymemo-agent/issues/765) records completed
acceptance. The optional new-stack data wipe was omitted. Next-bill savings
confirmation remains tracked separately in
[issue #767](https://github.com/X-GPT/mymemo-agent/issues/767).

The original procedure is preserved in Git history at commit `256d699`.
For current operations, use the [front](agent-front.md) and
[Runtime](agent-runtime.md) runbooks.
