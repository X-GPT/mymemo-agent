import unittest
from check_v1_plan import check


class PlanTest(unittest.TestCase):
    def test_only_retired_deletions_and_protection_strip(self):
        def plan(address, actions, before=None, after=None):
            return {"resource_changes": [{"mode": "managed", "address": address, "change": {"actions": actions, "before": before, "after": after}}]}
        check(plan("aws_ecs_service.chat_api", ["delete"]), "delete")
        check(plan("aws_security_group.runtime", ["no-op"]), "delete")
        check(plan("aws_db_instance.agent", ["update"], {"deletion_protection": True, "skip_final_snapshot": False}, {"deletion_protection": False, "skip_final_snapshot": True}), "strip")
        for address, actions in [("aws_s3_bucket.workspace", ["delete"]), ("aws_bedrockagentcore_agent_runtime.agent_runtime", ["update"]), ("aws_ecs_service.chat_api", ["delete", "create"])]:
            with self.assertRaises(ValueError):
                check(plan(address, actions), "delete")
        with self.assertRaises(ValueError):
            check(plan("aws_db_instance.agent", ["delete"]), "strip")


if __name__ == "__main__":
    unittest.main()
