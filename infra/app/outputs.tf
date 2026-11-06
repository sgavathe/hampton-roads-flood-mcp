output "app_url" {
  value = "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "mcp_url" {
  value = "https://${azurerm_container_app.web.ingress[0].fqdn}/mcp"
}

output "mcp_api_key" {
  description = "Bearer key for /mcp. Read with: terraform output -raw mcp_api_key"
  value       = random_password.mcp_api_key.result
  sensitive   = true
}

output "container_app_name" {
  value = azurerm_container_app.web.name
}

output "acr_name" {
  value = azurerm_container_registry.this.name
}

output "acr_login_server" {
  value = azurerm_container_registry.this.login_server
}

output "nat_egress_ip" {
  description = "Static public IP all outbound traffic leaves from (allow-list it with partners if needed)."
  value       = var.enable_nat_gateway ? azurerm_public_ip.nat[0].ip_address : null
}

output "openai_endpoint" {
  value = var.enable_ai ? azurerm_cognitive_account.openai[0].endpoint : null
}

output "openai_public_access" {
  value = var.enable_ai ? azurerm_cognitive_account.openai[0].public_network_access_enabled : null
}
