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

data "aws_ecs_cluster" "shared" {
  count = local.shared_ecs_cluster_arn_output == null && local.shared_ecs_cluster_name_output != null ? 1 : 0

  cluster_name = local.shared_ecs_cluster_name_output
}
