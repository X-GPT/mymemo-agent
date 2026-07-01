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

data "aws_subnet" "shared_ecs_first" {
  id = local.shared_ecs_subnet_ids[0]
}

data "aws_lb" "shared" {
  arn = data.terraform_remote_state.mymemo_service.outputs.alb_arn
}

data "aws_lb_listener" "shared_https" {
  load_balancer_arn = data.aws_lb.shared.arn
  port              = 443
}

data "aws_ecs_cluster" "shared" {
  cluster_name = data.terraform_remote_state.mymemo_service.outputs.ecs_cluster_name
}
