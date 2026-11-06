# One-time bootstrap, run locally with `az login` as a subscription Owner.
# Creates everything GitHub Actions needs to deploy without stored secrets:
#   - remote state storage (Entra ID auth only, no shared keys)
#   - the app resource group the pipeline is scoped to
#   - an Entra app + federated credentials (GitHub OIDC)
#   - least-privilege role assignments for that identity

terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.20" }
    azuread = { source = "hashicorp/azuread", version = "~> 3.1" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  features {}
  storage_use_azuread = true

  # The deploy identity is scoped to one resource group, so it cannot register
  # providers at subscription level. Register them once here (idempotent).
  resource_providers_to_register = var.resource_providers
}

provider "azuread" {}

data "azurerm_client_config" "current" {}
data "azurerm_subscription" "current" {}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  repo = "${var.github_owner}/${var.github_repo}"
  tags = { project = var.prefix, managed_by = "terraform", stack = "bootstrap" }

  # Roles the pipeline may hand out to the app's managed identity, nothing else.
  delegable_role_ids = [
    "7f951dda-4ed3-4680-a7ca-43fe172d538d", # AcrPull
    "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd", # Cognitive Services OpenAI User
  ]
  delegable_guids = join(", ", local.delegable_role_ids)
}

# ---------- Remote state ----------
resource "azurerm_resource_group" "tfstate" {
  name     = "rg-${var.prefix}-tfstate"
  location = var.location
  tags     = local.tags
}

resource "azurerm_storage_account" "tfstate" {
  name                            = "st${replace(var.prefix, "-", "")}${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.tfstate.name
  location                        = azurerm_resource_group.tfstate.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy { days = 7 }
  }
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

# ---------- App resource group (the pipeline's blast radius) ----------
resource "azurerm_resource_group" "app" {
  name     = "rg-${var.prefix}"
  location = var.location
  tags     = local.tags
}

# ---------- GitHub OIDC identity ----------
resource "azuread_application" "github" {
  display_name = "github-${var.prefix}-deploy"
  owners       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal" "github" {
  client_id = azuread_application.github.client_id
  owners    = [data.azurerm_client_config.current.object_id]
}

# Deploys run in the `production` GitHub environment; PRs get plan-only access.
resource "azuread_application_federated_identity_credential" "environment" {
  application_id = azuread_application.github.id
  display_name   = "github-env-${var.github_environment}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${local.repo}:environment:${var.github_environment}"
}

resource "azuread_application_federated_identity_credential" "pull_request" {
  application_id = azuread_application.github.id
  display_name   = "github-pull-request"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${local.repo}:pull_request"
}

# ---------- Least-privilege role assignments ----------
resource "azurerm_role_assignment" "app_contributor" {
  scope                = azurerm_resource_group.app.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.github.object_id
}

# Can create role assignments in the app RG, but only for the roles above.
resource "azurerm_role_assignment" "app_rbac_admin" {
  scope                = azurerm_resource_group.app.id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azuread_service_principal.github.object_id
  condition_version    = "2.0"
  condition            = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.delegable_guids}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.delegable_guids}}
     )
    )
  EOT
}

resource "azurerm_role_assignment" "state_blob" {
  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azuread_service_principal.github.object_id
}
