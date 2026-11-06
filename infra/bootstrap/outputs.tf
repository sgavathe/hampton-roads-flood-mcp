output "azure_client_id" {
  value = azuread_application.github.client_id
}

output "azure_tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "azure_subscription_id" {
  value = data.azurerm_subscription.current.subscription_id
}

output "app_resource_group" {
  value = azurerm_resource_group.app.name
}

output "tfstate_resource_group" {
  value = azurerm_resource_group.tfstate.name
}

output "tfstate_storage_account" {
  value = azurerm_storage_account.tfstate.name
}

# Paste these into a terminal (GitHub CLI) to configure the repo. None are secrets.
output "github_setup_commands" {
  value = <<-EOT
    gh api -X PUT repos/${var.github_owner}/${var.github_repo}/environments/${var.github_environment}
    gh variable set AZURE_CLIENT_ID       -R ${var.github_owner}/${var.github_repo} -b ${azuread_application.github.client_id}
    gh variable set AZURE_TENANT_ID       -R ${var.github_owner}/${var.github_repo} -b ${data.azurerm_client_config.current.tenant_id}
    gh variable set AZURE_SUBSCRIPTION_ID -R ${var.github_owner}/${var.github_repo} -b ${data.azurerm_subscription.current.subscription_id}
    gh variable set APP_RESOURCE_GROUP    -R ${var.github_owner}/${var.github_repo} -b ${azurerm_resource_group.app.name}
    gh variable set TFSTATE_RESOURCE_GROUP -R ${var.github_owner}/${var.github_repo} -b ${azurerm_resource_group.tfstate.name}
    gh variable set TFSTATE_STORAGE_ACCOUNT -R ${var.github_owner}/${var.github_repo} -b ${azurerm_storage_account.tfstate.name}
    gh variable set AZURE_LOCATION        -R ${var.github_owner}/${var.github_repo} -b ${var.location}
    gh variable set NAME_PREFIX           -R ${var.github_owner}/${var.github_repo} -b ${var.prefix}
  EOT
}
