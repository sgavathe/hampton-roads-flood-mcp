data "azurerm_resource_group" "app" {
  name = var.resource_group_name
}

resource "random_string" "suffix" {
  length  = 5
  special = false
  upper   = false
}

locals {
  name     = "${var.prefix}-${random_string.suffix.result}"
  compact  = "${replace(var.prefix, "-", "")}${random_string.suffix.result}"
  location = coalesce(var.location, data.azurerm_resource_group.app.location)
  tags     = { project = var.prefix, managed_by = "terraform", stack = "app" }
}

# ---------- Observability ----------
resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${local.name}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.5
  tags                = local.tags
}

# ---------- Identity used by the running container ----------
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  tags                = local.tags
}

# ---------- Container registry (pulled via managed identity, no admin user) ----------
resource "azurerm_container_registry" "this" {
  name                = "acr${local.compact}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------- MCP endpoint key ----------
# Rotate with: terraform apply -replace=random_password.mcp_api_key
resource "random_password" "mcp_api_key" {
  length  = 48
  special = false
}

# ---------- Container Apps (scale to zero, inside the VNet) ----------
# A workload-profiles environment is required for VNet + NAT Gateway egress.
# Ingress stays public (it's a public demo site); everything behind it is private.
resource "azurerm_container_app_environment" "this" {
  name                           = "cae-${local.name}"
  resource_group_name            = data.azurerm_resource_group.app.name
  location                       = local.location
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id       = azurerm_subnet.apps.id
  internal_load_balancer_enabled = false
  tags                           = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  # The NAT association must exist before the environment starts using the subnet.
  depends_on = [azurerm_subnet_nat_gateway_association.apps]
}

resource "azurerm_container_app" "web" {
  name                         = "ca-${var.prefix}"
  resource_group_name          = data.azurerm_resource_group.app.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "mcp-api-key"
    value = random_password.mcp_api_key.result
  }

  dynamic "secret" {
    for_each = nonsensitive(var.arcgis_api_key == "") ? [] : [1]
    content {
      name  = "arcgis-api-key"
      value = var.arcgis_api_key
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 2

    container {
      name   = "web"
      image  = var.bootstrap_image # replaced by the pipeline on every deploy
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "MCP_API_KEY"
        secret_name = "mcp-api-key"
      }

      env {
        # Tells DefaultAzureCredential which user-assigned identity to use.
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }

      dynamic "env" {
        for_each = var.enable_ai ? {
          AZURE_OPENAI_ENDPOINT    = azurerm_cognitive_account.openai[0].endpoint
          AZURE_OPENAI_DEPLOYMENT  = azurerm_cognitive_deployment.agent[0].name
          AZURE_OPENAI_API_VERSION = var.openai_api_version
        } : {}
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = nonsensitive(var.arcgis_api_key == "") ? [] : [1]
        content {
          # Browser key, served to the page by /api/config. Restrict it by referrer in ArcGIS.
          name        = "ARCGIS_API_KEY"
          secret_name = "arcgis-api-key"
        }
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "30"
    }
  }

  # The pipeline owns the image tag (az containerapp update), Terraform owns the rest.
  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.openai_user,
    azurerm_private_endpoint.openai,
  ]
}
