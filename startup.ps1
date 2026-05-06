# startup.ps1 — NSSM startup wrapper for deployed help-bot
# Starts from the deployed working tree and performs a minimal repair if runtime artifacts are missing.
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

# Pull private config from game-ci/help-bot-config
$configFile = Join-Path $repoDir "config.json"
$configRepoDir = Join-Path $repoDir ".help-bot-config"
try {
    if (Test-Path $configRepoDir) {
        Log "Updating private config..."
        git -C $configRepoDir pull --ff-only 2>&1 | Out-Null
    } else {
        Log "Cloning private config..."
        gh repo clone game-ci/help-bot-config $configRepoDir -- --depth 1 2>&1 | Out-Null
    }
    if (Test-Path "$configRepoDir\config.json") {
        Copy-Item "$configRepoDir\config.json" $configFile -Force
        Log "Config loaded from help-bot-config"
    } else {
        Log "WARNING: No config.json in help-bot-config repo"
    }
} catch {
    Log "WARNING: Failed to pull private config: $_"
    if (-not (Test-Path $configFile)) {
        Log "Falling back to config.example.json"
        Copy-Item (Join-Path $repoDir "config.example.json") $configFile -Force
    }
}

$distCli = Join-Path $repoDir "dist\cli.js"
$nodeModulesDir = Join-Path $repoDir "node_modules"
$needsRepair = -not (Test-Path $distCli) -or -not (Test-Path $nodeModulesDir)

if ($needsRepair) {
    Log "Runtime artifacts missing; repairing local install..."

    try {
        Log "Installing dependencies..."
        yarn install --frozen-lockfile 2>&1 | Out-Null
        Log "  yarn install: done"
    } catch {
        Log "  yarn install failed: $_"
    }

    try {
        Log "Building..."
        yarn build 2>&1 | Out-Null
        Log "  Build: done"
    } catch {
        Log "  Build failed: $_"
    }
} else {
    Log "Runtime artifacts present; skipping repair build"
}

Log "Starting bot..."

# Step 4: Run the bot (this replaces the script process — NSSM monitors it)
$nodePath = (Get-Command node).Source
& $nodePath "$repoDir\dist\cli.js" live --dispatch-mode triage
