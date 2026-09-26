# Restart the Web GUI so it loads the vault's updated Host half.
#
# A client-plugin update hot-reloads by itself; the Host half does not, because
# the plugin lives outside the profile directory and nothing watches it. This
# script stops the process listening on the GUI port and starts a fresh one in
# its own window, so the console stays available after this script exits.
#
# Usage:  pwsh -File restart-web.ps1 -Checkout <dsh source checkout>
#         pwsh -File restart-web.ps1 -Port 3080 -Checkout /path/to/deepseek-harness
#
# The checkout defaults to $env:DSH_CHECKOUT so no machine-specific path has to
# live in the repository.

[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$Checkout = $env:DSH_CHECKOUT
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Checkout)) {
  throw 'pass -Checkout <dsh source checkout>, or set $env:DSH_CHECKOUT to it'
}

if (-not (Test-Path (Join-Path $Checkout 'package.json'))) {
  throw "no package.json under '$Checkout' — pass -Checkout with the dsh source checkout root"
}

function Get-ListenerPid {
  param([int]$LocalPort)
  $lines = netstat -ano | Select-String ":$LocalPort\s+.*LISTENING\s+(\d+)\s*$"
  foreach ($line in $lines) {
    $match = [regex]::Match($line.Line, 'LISTENING\s+(\d+)\s*$')
    if ($match.Success) { return [int]$match.Groups[1].Value }
  }
  return $null
}

$existing = Get-ListenerPid -LocalPort $Port
if ($null -eq $existing) {
  Write-Host "nothing is listening on $Port; starting a fresh dsh web" -ForegroundColor Yellow
} else {
  # Ending a process by port alone is how an unrelated server gets killed:
  # confirm it is a JavaScript runtime before stopping anything.
  $target = Get-Process -Id $existing -ErrorAction SilentlyContinue
  if ($null -eq $target) {
    throw "pid $existing is listening on $Port but cannot be inspected; stop it yourself, then re-run this script"
  }
  if ($target.ProcessName -notin @('node', 'pnpm', 'bun', 'deno')) {
    throw "pid $existing on port $Port is '$($target.ProcessName)', not a JavaScript runtime; refusing to stop it"
  }
  Write-Host "stopping pid $existing ($($target.ProcessName), the current $Port listener)" -ForegroundColor Yellow
  Stop-Process -Id $existing -Force
  # Wait for the socket to be released; starting too early fails on EADDRINUSE.
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    if ($null -eq (Get-ListenerPid -LocalPort $Port)) { break }
  }
  if ($null -ne (Get-ListenerPid -LocalPort $Port)) {
    throw "port $Port is still held after 6s; free it yourself, then re-run this script"
  }
}

Write-Host "starting dsh web from $Checkout" -ForegroundColor Green
Start-Process -FilePath 'pnpm' -ArgumentList 'run', 'start:web' -WorkingDirectory $Checkout

Write-Host ''
Write-Host 'a new window is starting the server; wait for it to print its URL, then reload the GUI.' -ForegroundColor Green
Write-Host 'the vault will migrate its database on first open (hidden column, system tags).' -ForegroundColor Green
