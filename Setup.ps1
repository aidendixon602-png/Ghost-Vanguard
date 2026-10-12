$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 24 or newer, then reopen PowerShell and run this script again.'
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 24) { throw 'Midtown Vanguard requires Node.js 24 or newer.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm was not found. Repair your Node.js installation.' }

function Invoke-NpmStep {
    param([string[]]$Arguments)
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm step failed: $($Arguments -join ' ')" }
}

Write-Host 'Installing Midtown Vanguard dependencies...' -ForegroundColor Cyan
Invoke-NpmStep -Arguments @('ci')
Invoke-NpmStep -Arguments @('run', 'build')
Invoke-NpmStep -Arguments @('test')

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Fill DISCORD_TOKEN, DISCORD_CLIENT_ID and DEVELOPER_IDS (your Discord user ID) in Notepad. Save and close it.' -ForegroundColor Yellow
    Start-Process notepad.exe -ArgumentList ('"' + (Join-Path $PSScriptRoot '.env') + '"') -Wait
    Read-Host 'Press Enter after saving your settings'
}

Invoke-NpmStep -Arguments @('run', 'doctor')
Write-Host 'Setup complete. Double-click Start.cmd, or run npm start here.' -ForegroundColor Green
Write-Host 'Developer invites auto-authorize with View Audit Log. Otherwise run /authserver within 120 seconds.'
Write-Host 'Then configure /security config and /antinuke enable.'

Write-Host 'Global commands synchronize automatically when the bot starts. No registration step is needed.'
Write-Host 'Uploading to a host: replace the whole dist/ and scripts/ folders, and keep your existing .env and data/.' -ForegroundColor Cyan
