variable "prefix" {
  description = "Short name used in resource names (lowercase letters, digits, hyphens)."
  type        = string
  default     = "flood-mcp"

  validation {
    condition     = can(regex("^[a-z0-9-]{3,14}$", var.prefix))
    error_message = "prefix must be 3-14 chars of lowercase letters, digits or hyphens."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus2"
}

variable "github_owner" {
  description = "GitHub user or org that owns the repo."
  type        = string
  default     = "sgavathe"
}

variable "github_repo" {
  description = "GitHub repository name."
  type        = string
  default     = "hampton-roads-flood-mcp"
}

variable "github_environment" {
  description = "GitHub Actions environment that is allowed to deploy."
  type        = string
  default     = "production"
}

variable "resource_providers" {
  description = "Resource providers the app stack needs."
  type        = list(string)
  default = [
    "Microsoft.App",
    "Microsoft.ContainerRegistry",
    "Microsoft.ManagedIdentity",
    "Microsoft.OperationalInsights",
  ]
}
