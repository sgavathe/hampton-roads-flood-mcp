variable "prefix" {
  description = "Short name used in resource names."
  type        = string
  default     = "flood-mcp"
}

variable "resource_group_name" {
  description = "Existing resource group created by infra/bootstrap."
  type        = string
}

variable "location" {
  description = "Region override. Defaults to the resource group's region."
  type        = string
  default     = null
}

variable "arcgis_api_key" {
  description = "Optional ArcGIS Location Platform API key (browser key, referrer-restricted). Enables 3D buildings."
  type        = string
  default     = ""
  sensitive   = true
}

variable "bootstrap_image" {
  description = "Placeholder used only on first create, before CI pushes the real image. Must listen on 8080."
  type        = string
  default     = "docker.io/nginxinc/nginx-unprivileged:alpine"
}
