resource "aws_bedrockagentcore_code_interpreter" "workspace" {
  name = "mymemo_workspace_${var.environment}"

  network_configuration {
    network_mode = "SANDBOX"
  }
}

output "code_interpreter_id" {
  value = aws_bedrockagentcore_code_interpreter.workspace.code_interpreter_id
}
