# Shared with the front (#742): the untrusted hand has no role or VPC access.
resource "aws_bedrockagentcore_code_interpreter" "hand" {
  name = "mymemo_hand_${var.environment}"
  network_configuration {
    network_mode = "SANDBOX"
  }
}
