# Security group descriptions are replacement-only in AWS. These fixed-name
# groups cannot be replaced while ECS and ElastiCache network interfaces use them.
resource "aws_security_group" "live_redis" {
  name        = "${local.common_name}-live-redis"
  description = "Private Redis live preview lane for trusted agent services"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group" "live_redis_clients" {
  name        = "${local.common_name}-live-redis-clients"
  description = "chat-api and AgentCore Runtime clients of the Redis Live Stream lane"
  vpc_id      = local.shared_vpc_id
}

resource "aws_security_group_rule" "live_redis_from_services" {
  type                     = "ingress"
  description              = "Trusted agent services to the Redis Live Stream"
  security_group_id        = aws_security_group.live_redis.id
  source_security_group_id = aws_security_group.live_redis_clients.id
  from_port                = var.live_redis_port
  to_port                  = var.live_redis_port
  protocol                 = "tcp"
}

resource "aws_elasticache_subnet_group" "live" {
  name       = "${local.common_name}-live"
  subnet_ids = local.shared_ecs_subnet_ids
}

resource "random_password" "live_redis" {
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "live" {
  replication_group_id = substr(replace("${local.common_name}-live", "_", "-"), 0, 40)
  description          = "Ephemeral Redis pub/sub relay for AG-UI Live Stream delivery"

  engine         = "redis"
  engine_version = var.live_redis_engine_version
  node_type      = var.live_redis_node_type
  port           = var.live_redis_port

  num_cache_clusters         = 1
  automatic_failover_enabled = false
  multi_az_enabled           = false

  subnet_group_name  = aws_elasticache_subnet_group.live.name
  security_group_ids = [aws_security_group.live_redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.live_redis.result
  auth_token_update_strategy = "SET"

  snapshot_retention_limit = 0
  apply_immediately        = true
}

resource "aws_secretsmanager_secret" "live_redis_url" {
  name                    = "${local.common_name}-REDIS_URL"
  description             = "Authenticated TLS URL for the Redis Live Stream relay"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "live_redis_url" {
  secret_id     = aws_secretsmanager_secret.live_redis_url.id
  secret_string = "rediss://default:${urlencode(random_password.live_redis.result)}@${aws_elasticache_replication_group.live.primary_endpoint_address}:${var.live_redis_port}"
}
