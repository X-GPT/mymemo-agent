data "terraform_remote_state" "mymemo_agent" {
  backend = "s3"

  config = {
    bucket       = "mymemo-terraform-state-bucket"
    key          = "mymemo-agent/prod.tfstate"
    region       = "us-west-2"
    use_lockfile = true
    encrypt      = true
  }
}

data "terraform_remote_state" "mymemo_service" {
  backend = "s3"

  config = {
    bucket       = "mymemo-terraform-state-bucket"
    key          = "mymemo/staging.tfstate"
    region       = "us-west-2"
    use_lockfile = true
    encrypt      = true
  }
}

data "aws_security_group" "live_redis_clients" {
  vpc_id = data.terraform_remote_state.mymemo_agent.outputs.shared_infra.vpc_id

  filter {
    name   = "group-name"
    values = ["mymemo-agent-${var.environment}-live-redis-clients"]
  }
}
