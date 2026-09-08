#!/usr/bin/env python3
"""Reject a teardown plan that changes anything outside the retired resources."""
import json
import sys
from pathlib import Path


def check(plan, phase):
    retired = set(Path(__file__).with_name("v1-resources.txt").read_text().splitlines())
    for resource in plan.get("resource_changes", []):
        if resource["mode"] != "managed":
            continue
        change = resource["change"]
        actions = change["actions"]
        address = resource["address"].split("[", 1)[0]
        if actions == ["no-op"]:
            continue
        if phase == "delete" and address in retired and actions == ["delete"]:
            continue
        if phase == "strip" and address == "aws_db_instance.agent" and actions == ["update"]:
            before, after = change["before"], change["after"]
            changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
            if changed <= {"deletion_protection", "skip_final_snapshot"} and after["deletion_protection"] is False and after["skip_final_snapshot"] is True:
                continue
        raise ValueError(f"Unexpected {actions} for {resource['address']}")


if __name__ == "__main__":
    check(json.load(sys.stdin), sys.argv[1])
