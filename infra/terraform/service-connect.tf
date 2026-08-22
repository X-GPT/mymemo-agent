resource "aws_service_discovery_http_namespace" "services" {
  name        = local.service_connect_namespace_name
  description = "Private ECS Service Connect namespace for ${local.common_name}"
}
