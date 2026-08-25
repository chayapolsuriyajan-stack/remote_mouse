<#
.SYNOPSIS
  Starts the remote-mouse server on this PC and prints the URL/QR for your phone.

.DESCRIPTION
  Creates a local virtual environment on first run, installs dependencies into
  it, then runs the server. Re-runs skip straight to starting up.

.PARAMETER AddFirewallRule
  Adds the one-time inbound firewall rule so your phone can reach the server.
  Requires an elevated PowerShell; you only ever need this once.

.EXAMPLE
  .\run.ps1
  .\run.ps1 -AddFirewallRule
#>
[CmdletBinding()]
param(
  [switch]$AddFirewallRule,
  [int]$Port = 0
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if ($AddFirewallRule) {
  $rulePort = if ($Port -gt 0) { $Port } else { 8090 }
  Write-Host "Adding inbound firewall rule for TCP $rulePort (needs an elevated prompt)..."
  netsh advfirewall firewall add rule name="Remote Mouse" dir=in action=allow protocol=TCP localport=$rulePort | Out-Null
  Write-Host "Firewall rule added."
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "Creating virtual environment (first run only)..."
  py -3 -m venv .venv
  & $python -m pip install --upgrade pip --quiet
  & $python -m pip install -r requirements.txt
}

if ($Port -gt 0) { $env:REMOTE_MOUSE_PORT = "$Port" }

& $python (Join-Path $PSScriptRoot "server\main.py")
