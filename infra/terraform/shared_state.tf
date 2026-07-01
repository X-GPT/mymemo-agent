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

data "aws_lb" "shared" {
  count = local.shared_alb_arn_output != null && (local.shared_alb_listener_arn_output == null || local.shared_alb_security_group_id_output == null) ? 1 : 0

  arn = local.shared_alb_arn_output
}

data "aws_lb_listener" "shared_https" {
  count = local.shared_alb_listener_arn_output == null && local.shared_alb_arn_output != null ? 1 : 0

  load_balancer_arn = data.aws_lb.shared[0].arn
  port              = 443
}

data "aws_ecs_cluster" "shared" {
  count = local.shared_ecs_cluster_arn_output == null && local.shared_ecs_cluster_name_output != null ? 1 : 0

  cluster_name = local.shared_ecs_cluster_name_output
}
