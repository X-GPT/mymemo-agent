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

data "aws_vpc" "shared" {
  id = local.shared_vpc_id
}

data "aws_subnet" "shared_ecs_first" {
  count = local.shared_vpc_id_output == null ? 1 : 0

  id = local.shared_ecs_subnet_ids[0]
}

data "aws_ecs_cluster" "shared" {
  count = local.shared_ecs_cluster_arn_output == null && local.shared_ecs_cluster_name_output != null ? 1 : 0

  cluster_name = local.shared_ecs_cluster_name_output
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_kms_alias" "agentcore_dispatch_queue" {
  name = local.agentcore_dispatch_queue_kms_alias_name
}
