provider "aws" {
  region = "us-west-2"

  default_tags {
    tags = {
      Environment = "dev"
      ManagedBy   = "terraform"
      Project     = "mymemo-agent"
    }
  }
}
