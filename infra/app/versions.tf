terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.20" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # Partial config: the workflow supplies resource_group_name, storage_account_name,
  # container_name and key via -backend-config. Auth is OIDC + Entra ID (no keys).
  backend "azurerm" {
    use_oidc         = true
    use_azuread_auth = true
  }
}

provider "azurerm" {
  features {}
  # Providers were registered by the bootstrap stack; this identity is RG-scoped.
  resource_provider_registrations = "none"
  storage_use_azuread             = true
}
