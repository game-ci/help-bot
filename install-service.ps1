# Install gameci-help-bot as NSSM service (must run as admin)
# Uses startup.ps1 wrapper for auto-update on every service start.
$ErrorActionPreference = "Stop"
$serviceName = "gameci-help-bot"
$appDir = "C:\game-ci\help-bot"
$startupScript = "$appDir\startup.ps1"
$pwshPath = (Get-Command powershell).Source
$logFile = "C:\game-ci\help-bot\logs\service.log"
$resultFile = "C:\game-ci\help-bot\logs\install-result.txt"

# Read tokens from .env
$envContent = Get-Content "$appDir\.env" -Raw
$tokens = @{}
foreach ($line in ($envContent -split "`n")) {
    $line = $line.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line -split '=', 2
        $tokens[$parts[0].Trim()] = $parts[1].Trim()
    }
}

# Ensure logs directory exists
New-Item -ItemType Directory -Force -Path "$appDir\logs" | Out-Null

$log = @()
try {
    $log += "Installing $serviceName..."
    nssm install $serviceName $pwshPath "-ExecutionPolicy" "Bypass" "-File" $startupScript
    $log += "  nssm install: exit $LASTEXITCODE"

    nssm set $serviceName AppDirectory $appDir
    $log += "  AppDirectory set"

    nssm set $serviceName AppStdout $logFile
    nssm set $serviceName AppStderr $logFile
    nssm set $serviceName AppStdoutCreationDisposition 1
    nssm set $serviceName AppStderrCreationDisposition 1
    $log += "  Logging configured"

    # Set environment variables (including PATH for Claude CLI)
    $envArgs = @()
    if ($tokens['DISCORD_BOT_TOKEN']) { $envArgs += "DISCORD_BOT_TOKEN=$($tokens['DISCORD_BOT_TOKEN'])" }
    if ($tokens['GITHUB_TOKEN']) { $envArgs += "GITHUB_TOKEN=$($tokens['GITHUB_TOKEN'])" }
    $userLocalBin = "$env:USERPROFILE\.local\bin"
    $envArgs += "PATH=$env:PATH;$userLocalBin"
    if ($envArgs.Count -gt 0) {
        nssm set $serviceName AppEnvironmentExtra $envArgs
        $log += "  Env vars set ($($envArgs.Count) entries)"
    }

    nssm start $serviceName
    $log += "  Service started"

    $status = nssm status $serviceName
    $log += "  Status: $status"
    $log += "SUCCESS"
} catch {
    $log += "ERROR: $_"
}

$log | Out-File -FilePath $resultFile -Encoding utf8
$log | ForEach-Object { Write-Host $_ }
