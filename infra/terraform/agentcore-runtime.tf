removed {
  from = aws_ecr_repository.production_runtime

  lifecycle {
    destroy = false
  }
}
