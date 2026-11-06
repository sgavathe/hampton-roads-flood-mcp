# ---------- Network: the Azure equivalent of the AWS VPC setup ----------
#   VNet (VPC)  10.40.0.0/16
#   snet-apps   10.40.0.0/23  Container Apps environment (delegated); egress via NAT Gateway
#   snet-pe     10.40.2.0/24  private endpoints (Azure OpenAI)
#   NAT Gateway + static public IP: all outbound calls (Open-Meteo, NOAA, Esri, ACR)
#   leave from one known address, like a NAT gateway in a public subnet on AWS.

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${local.name}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = data.azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 7, 0)] # /23

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                              = "snet-pe"
  resource_group_name               = data.azurerm_resource_group.app.name
  virtual_network_name              = azurerm_virtual_network.this.name
  address_prefixes                  = [cidrsubnet(var.vnet_address_space, 8, 2)] # /24
  private_endpoint_network_policies = "Disabled"
}

# ---------- NAT Gateway (fixed egress IP) ----------
resource "azurerm_public_ip" "nat" {
  count               = var.enable_nat_gateway ? 1 : 0
  name                = "pip-nat-${local.name}"
  resource_group_name = data.azurerm_resource_group.app.name
  location            = local.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway" "this" {
  count                   = var.enable_nat_gateway ? 1 : 0
  name                    = "ng-${local.name}"
  resource_group_name     = data.azurerm_resource_group.app.name
  location                = local.location
  sku_name                = "Standard"
  idle_timeout_in_minutes = 4
  tags                    = local.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  count                = var.enable_nat_gateway ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.this[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

resource "azurerm_subnet_nat_gateway_association" "apps" {
  count          = var.enable_nat_gateway ? 1 : 0
  subnet_id      = azurerm_subnet.apps.id
  nat_gateway_id = azurerm_nat_gateway.this[0].id
}
