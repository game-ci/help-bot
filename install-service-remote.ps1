# Install gameci-help-bot NSSM service on COOLMASTER-DESK via WinRM
# This script runs locally and invokes commands on the remote machine

$resultFile = "C:\game-ci\help-bot\logs\remote-install-result.txt"

# Read local .env to extract tokens for the remote service
$tokens = @{}
foreach ($line in (Get-Content 'C:\game-ci\help-bot\.env')) {
    $line = $line.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line -split '=', 2
        $tokens[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$discordToken = $tokens['DISCORD_BOT_TOKEN']
$githubToken = $tokens['GITHUB_TOKEN']

$result = Invoke-Command -ComputerName COOLMASTER-DESK -ScriptBlock {
    param($discordToken, $githubToken)

    $serviceName = "gameci-help-bot"
    $nodePath = (Get-Command node).Source
    $scriptPath = "C:\game-ci\help-bot\dist\cli.js"
    $appDir = "C:\game-ci\help-bot"
    $logFile = "C:\game-ci\help-bot\logs\service.log"

    # Ensure logs directory exists
    New-Item -ItemType Directory -Force -Path "C:\game-ci\help-bot\logs" | Out-Null

    $log = @()
    try {
        # Remove existing service if present
        $existing = nssm status $serviceName 2>&1
        if ($LASTEXITCODE -eq 0) {
            $log += "Existing service found ($existing), removing..."
            nssm stop $serviceName 2>&1 | Out-Null
            nssm remove $serviceName confirm 2>&1 | Out-Null
            Start-Sleep -Seconds 2
        }

        $log += "Installing $serviceName..."
        nssm install $serviceName $nodePath $scriptPath live --dispatch-mode approval
        $log += "  nssm install exit: $LASTEXITCODE"

        nssm set $serviceName AppDirectory $appDir
        $log += "  AppDirectory set"

        nssm set $serviceName AppStdout $logFile
        nssm set $serviceName AppStderr $logFile
        nssm set $serviceName AppStdoutCreationDisposition 1
        nssm set $serviceName AppStderrCreationDisposition 1
        $log += "  Logging configured"

        # Set environment variables
        $envArgs = @()
        if ($discordToken) { $envArgs += "DISCORD_BOT_TOKEN=$discordToken" }
        if ($githubToken) { $envArgs += "GITHUB_TOKEN=$githubToken" }
        if ($envArgs.Count -gt 0) {
            nssm set $serviceName AppEnvironmentExtra $envArgs
            $log += "  Env vars set ($($envArgs.Count) entries)"
        }

        nssm start $serviceName
        $log += "  Start command issued"

        Start-Sleep -Seconds 2
        $status = nssm status $serviceName
        $log += "  Status: $status"
        $log += "SUCCESS"
    } catch {
        $log += "ERROR: $_"
    }

    return $log
} -ArgumentList $discordToken, $githubToken

$result | Out-File -FilePath $resultFile -Encoding utf8
$result | ForEach-Object { Write-Host $_ }
