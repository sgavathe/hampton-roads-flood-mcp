# ---------- Azure OpenAI for "Ask the map" ----------
# Keyless (Entra ID only) and, by default, reachable only from inside the VNet
# through a private endpoint: public network access is disabled.

locals {
  ai_private = var.enable_ai && var.openai_private_endpoint
}

resource "azurerm_cognitive_account" "openai" {
  count                         = var.enable_ai ? 1 : 0
  name                          = "oai-${local.name}"
  resource_group_name           = data.azurerm_resource_group.app.name
  location                      = coalesce(var.openai_location, local.location)
  kind                          = "OpenAI"
  sku_name                      = "S0"
  custom_subdomain_name         = "oai-${local.name}" # required for Entra ID auth and private endpoints
  local_auth_enabled            = false               # no API keys at all
  public_network_access_enabled = !var.openai_private_endpoint
  tags                          = local.tags
}

resource "azurerm_cognitive_deployment" "agent" {
  count                = var.enable_ai ? 1 : 0
  name                 = var.openai_deployment_name
  cognitive_account_id = azurerm_cognitive_account.openai[0].id

  model {
    format  = "OpenAI"
    name    = var.openai_model_name
    version = var.openai_model_version
  }

  sku {
    name     = "GlobalStandard"
    capacity = var.openai_capacity_k_tpm # thousands of tokens per minute; also caps spend
  }

  version_upgrade_option = "OnceNewDefaultVersionAvailable"
}

resource "azurerm_role_assignment" "openai_user" {
  count                = var.enable_ai ? 1 : 0
  scope                = azurerm_cognitive_account.openai[0].id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------- Private endpoint + private DNS ----------
resource "azurerm_private_dns_zone" "openai" {
  count               = local.ai_private ? 1 : 0
  name                = "privatelink.openai.azure.com"
  resource_group_name = data.azurerm_resource_group.app.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "openai" {
  count                 = local.ai_private ? 1 : 0
  name                  = "link-${local.name}"
  resource_group_name   = data.azurerm_resource_group.app.name
  private_dns_zone_name = azurerm_private_dns_zone.openai[0].name
  virtual_network_id    = azurerm_virtual_network.this.id
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "openai" {
  count               = local.ai_private ? 1 : 0
  name                = "pe-oai-${local.name}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "oai"
    private_connection_resource_id = azurerm_cognitive_account.openai[0].id
    subresource_names              = ["account"]
    is_manual_connection           = false
  }

  # Registers oai-<name>.privatelink.openai.azure.com -> private IP, so the app's
  # normal endpoint URL resolves privately from inside the VNet.
  private_dns_zone_group {
    name                 = "openai"
    private_dns_zone_ids = [azurerm_private_dns_zone.openai[0].id]
  }
  # The account rejects private endpoints while it is still provisioning or
  # being updated by the model deployment, so wait for both.
  depends_on = [azurerm_cognitive_deployment.agent]
}
