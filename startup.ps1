# startup.ps1 — Auto-update wrapper for NSSM service
# Runs on every service start (including reboot): pulls latest, builds, then starts the bot.
$ErrorActionPreference = "Continue"
$repoDir = "C:\game-ci\help-bot"
$logFile = "$repoDir\logs\startup.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Tee-Object -FilePath $logFile -Append
}

Set-Location $repoDir
New-Item -ItemType Directory -Force -Path "$repoDir\logs" | Out-Null

Log "=== Service starting ==="

# Step 1: git pull
try {
    Log "Pulling latest from main..."
    $pullOutput = git pull origin main 2>&1 | Out-String
    Log "  git pull: $($pullOutput.Trim())"
} catch {
    Log "  git pull failed: $_ (continuing with current version)"
}

# Step 2: npm ci
try {
    Log "Installing dependencies..."
    npm ci 2>&1 | Out-Null
    Log "  npm ci: done"
} catch {
    Log "  npm ci failed: $_ (continuing with current modules)"
}

# Step 3: Build
try {
    Log "Building..."
    npm run build 2>&1 | Out-Null
    Log "  Build: done"
} catch {
    Log "  Build failed: $_ (continuing with existing dist)"
}

Log "Starting bot..."

# Step 4: Run the bot (this replaces the script process — NSSM monitors it)
$nodePath = (Get-Command node).Source
& $nodePath "$repoDir\dist\cli.js" live --dispatch-mode triage
