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
