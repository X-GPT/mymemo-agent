moved {
  from = aws_ecr_repository.runtime
  to   = aws_ecr_repository.legacy_runtime[0]
}

moved {
  from = aws_bedrockagentcore_agent_runtime.canary
  to   = aws_bedrockagentcore_agent_runtime.runtime
}

moved {
  from = aws_kms_alias.canary
  to   = aws_kms_alias.dispatch
}

moved {
  from = aws_kms_key.canary
  to   = aws_kms_key.dispatch
}

moved {
  from = aws_security_group.canary
  to   = aws_security_group.runtime
}

moved {
  from = aws_ssm_parameter.enabled
  to   = aws_ssm_parameter.dispatch_enabled
}
