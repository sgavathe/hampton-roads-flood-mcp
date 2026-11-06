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

# ---------- Network ----------
variable "vnet_address_space" {
  description = "VNet CIDR. Subnets: /23 for Container Apps, /24 for private endpoints."
  type        = string
  default     = "10.40.0.0/16"
}

variable "enable_nat_gateway" {
  description = "Route all outbound traffic through a NAT Gateway with a static public IP (about $35/month)."
  type        = bool
  default     = true
}

# ---------- Azure OpenAI ----------
variable "enable_ai" {
  description = "Deploy Azure OpenAI and enable the Ask-the-map agent."
  type        = bool
  default     = true
}

variable "openai_private_endpoint" {
  description = "Disable public access to Azure OpenAI and reach it only through a private endpoint in the VNet."
  type        = bool
  default     = true
}

variable "openai_location" {
  description = "Region for the Azure OpenAI account if the model has no quota in the main region. The private endpoint still lives in the VNet's region."
  type        = string
  default     = null
}

variable "openai_deployment_name" {
  type    = string
  default = "flood-agent"
}

variable "openai_model_name" {
  description = "Chat model with tool calling."
  type        = string
  default     = "gpt-4.1-mini"
}

variable "openai_model_version" {
  type    = string
  default = "2025-04-14"
}

variable "openai_api_version" {
  type    = string
  default = "2024-10-21"
}

variable "openai_capacity_k_tpm" {
  description = "Deployment quota in thousands of tokens per minute. Small on purpose: it also caps spend."
  type        = number
  default     = 20
}
