variable "aws_region" {
  description = "AWS region for the agent ECR repositories."
  type        = string
  default     = "us-west-2"
}

variable "tags" {
  description = "Tags applied to ECR repositories."
  type        = map(string)
  default = {
    Application = "mymemo-agent"
    ManagedBy   = "terraform"
  }
}
