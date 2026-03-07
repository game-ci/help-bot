<#
.SYNOPSIS
    Hydrates GitHub Actions secrets from locally stored credentials.

.DESCRIPTION
    Sets up an ephemeral self-hosted runner, dispatches the hydrate-secrets
    workflow, and pushes locally stored secrets (Discord bot token, etc.)
    to GitHub repo secrets. The runner accepts one job then auto-deregisters.

    Any contributor with gh CLI auth and the bot token in their local
    credential store can run this to provision secrets for CI.

.PARAMETER DryRun
    Show what would happen without executing.

.PARAMETER Token
    Pass the Discord bot token directly instead of reading from the credential store.

.PARAMETER Repo
    Override the target GitHub repository (default: detected from git remote).

.EXAMPLE
    .\automation\HydrateSecrets.ps1
    .\automation\HydrateSecrets.ps1 -DryRun
    .\automation\HydrateSecrets.ps1 -Token "ODk..."
#>

param(
    [switch]$DryRun,
    [string]$Token = "",
    [string]$Repo = ""
)

$ErrorActionPreference = "Stop"
$ScriptName = "HydrateSecrets"
$RunnerVersion = "2.321.0"

# --- Helpers ---

function Write-Status {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$ScriptName] $Message" -ForegroundColor $Color
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "--- $Message ---" -ForegroundColor Cyan
}

# --- Detect platform ---

function Get-RunnerPlatform {
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
        return "win-x64"
    }
    elseif ($IsMacOS) {
        $arch = & uname -m 2>$null
        if ($arch -eq "arm64") { return "osx-arm64" }
        return "osx-x64"
    }
    else {
        $arch = & uname -m 2>$null
        if ($arch -eq "aarch64" -or $arch -eq "arm64") { return "linux-arm64" }
        return "linux-x64"
    }
}

function Get-RunnerExtension {
    param([string]$Platform)
    if ($Platform -like "win-*") { return "zip" }
    return "tar.gz"
}

# --- Detect repo ---

function Get-GitHubRepo {
    if ($Repo) { return $Repo }

    $remote = & git remote get-url origin 2>$null
    if (-not $remote) {
        Write-Status "Could not detect GitHub repo from git remote." "Red"
        exit 1
    }

    # Extract owner/repo from URL
    $remote = $remote -replace '\.git$', ''
    if ($remote -match 'github\.com[:/](.+)$') {
        return $Matches[1]
    }

    Write-Status "Could not parse repo from remote: $remote" "Red"
    exit 1
}

# --- Extract token ---

function Get-DiscordToken {
    if ($Token) {
        Write-Status "Using token from -Token parameter." "Gray"
        return $Token
    }

    Write-Status "Extracting Discord bot token from credential store..." "Gray"

    # Try keytar (Node.js — same store the bot uses)
    $nodeScript = "const k = require('keytar'); k.getPassword('GameCI Help Bot', 'discord-bot-token').then(t => { if(t) process.stdout.write(t); else process.exit(1); }).catch(() => process.exit(1))"

    try {
        $extracted = & node -e $nodeScript 2>$null
        if ($LASTEXITCODE -eq 0 -and $extracted) {
            Write-Status "Token extracted from credential store." "Green"
            return $extracted
        }
    }
    catch { }

    # Fallback: check environment variable
    if ($env:DISCORD_BOT_TOKEN) {
        Write-Status "Using token from DISCORD_BOT_TOKEN environment variable." "Yellow"
        return $env:DISCORD_BOT_TOKEN
    }

    # Fallback: Windows DPAPI file
    $secFile = Join-Path $env:LOCALAPPDATA "GameCI" "discord-bot-token.sec"
    if (Test-Path $secFile) {
        try {
            $encrypted = Get-Content $secFile -Raw
            $secure = $encrypted | ConvertTo-SecureString
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            if ($plain) {
                Write-Status "Token extracted from DPAPI store." "Green"
                return $plain
            }
        }
        catch {
            Write-Status "DPAPI decryption failed: $($_.Exception.Message)" "Yellow"
        }
    }

    Write-Status "No Discord bot token found. Options:" "Red"
    Write-Status "  1. Run the help-bot once: node dist/cli.js cycle  (it will prompt and store the token)" "Gray"
    Write-Status "  2. Pass it directly: .\automation\HydrateSecrets.ps1 -Token 'your-token'" "Gray"
    Write-Status "  3. Set DISCORD_BOT_TOKEN environment variable" "Gray"
    exit 1
}

# --- Validate token ---

function Test-DiscordToken {
    param([string]$BotToken)

    Write-Status "Validating token against Discord API..." "Gray"

    try {
        $response = Invoke-WebRequest -Uri "https://discord.com/api/v10/users/@me" `
            -Headers @{ "Authorization" = "Bot $BotToken" } `
            -UseBasicParsing -ErrorAction Stop

        if ($response.StatusCode -eq 200) {
            $user = $response.Content | ConvertFrom-Json
            Write-Status "Token valid: $($user.username)#$($user.discriminator) (ID: $($user.id))" "Green"
            return $true
        }
    }
    catch {
        Write-Status "Token validation failed: $($_.Exception.Message)" "Red"
    }

    return $false
}

# --- Runner management ---

function Install-Runner {
    param([string]$RunnerDir)

    $platform = Get-RunnerPlatform
    $ext = Get-RunnerExtension $platform
    $url = "https://github.com/actions/runner/releases/download/v${RunnerVersion}/actions-runner-${platform}-${RunnerVersion}.${ext}"

    Write-Status "Downloading Actions runner v${RunnerVersion} (${platform})..." "Gray"
    Write-Status "  URL: $url" "Gray"

    if (-not (Test-Path $RunnerDir)) {
        New-Item -ItemType Directory -Path $RunnerDir -Force | Out-Null
    }

    if ($ext -eq "zip") {
        $zipPath = Join-Path $RunnerDir "runner.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $RunnerDir -Force
        Remove-Item $zipPath -Force
    }
    else {
        $tarPath = Join-Path $RunnerDir "runner.tar.gz"
        Invoke-WebRequest -Uri $url -OutFile $tarPath -UseBasicParsing
        & tar xzf $tarPath -C $RunnerDir
        Remove-Item $tarPath -Force
    }

    Write-Status "Runner installed to: $RunnerDir" "Green"
}

function Get-RegistrationToken {
    param([string]$RepoSlug)

    $result = & gh api "repos/${RepoSlug}/actions/runners/registration-token" --method POST --jq '.token' 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Status "Failed to get registration token. Ensure gh CLI is authenticated with admin access." "Red"
        Write-Status "  Run: gh auth login" "Gray"
        exit 1
    }
    return $result.Trim()
}

# --- Main ---

Write-Host ""
Write-Host "=== HydrateSecrets ===" -ForegroundColor Cyan
Write-Host "Push locally stored secrets to GitHub Actions" -ForegroundColor Gray
Write-Host ""

if ($DryRun) {
    Write-Status "DRY RUN mode -- no changes will be made." "Yellow"
    Write-Host ""
}

# Step 1: Detect repo
Write-Step "Detect repository"
$repoSlug = Get-GitHubRepo
Write-Status "Repository: $repoSlug" "White"

# Step 2: Extract token
Write-Step "Extract secrets"
$discordToken = Get-DiscordToken

# Collect all available secrets
$secrets = @{}
$secrets["DISCORD_BOT_TOKEN"] = $discordToken

# Check for other secrets in the environment
if ($env:DISCORD_GUILD_ID) {
    $secrets["DISCORD_GUILD_ID"] = $env:DISCORD_GUILD_ID
    Write-Status "DISCORD_GUILD_ID found in environment." "Gray"
}
if ($env:DISCORD_WEBHOOK_URL) {
    $secrets["DISCORD_WEBHOOK_URL"] = $env:DISCORD_WEBHOOK_URL
    Write-Status "DISCORD_WEBHOOK_URL found in environment." "Gray"
}
if ($env:ANTHROPIC_API_KEY) {
    $secrets["ANTHROPIC_API_KEY"] = $env:ANTHROPIC_API_KEY
    Write-Status "ANTHROPIC_API_KEY found in environment." "Gray"
}

Write-Status "$($secrets.Count) secret(s) to hydrate." "White"

# Step 3: Validate Discord token
Write-Step "Validate token"
$valid = Test-DiscordToken $discordToken
if (-not $valid) {
    Write-Status "Cannot proceed with an invalid token." "Red"
    exit 1
}

if ($DryRun) {
    Write-Step "DRY RUN Summary"
    Write-Status "Would create ephemeral runner with label: hydrate-secrets-XXXXXXXX" "Yellow"
    Write-Status "Would dispatch hydrate-secrets.yml workflow" "Yellow"
    Write-Status "Would push $($secrets.Count) secret(s) to $repoSlug" "Yellow"
    foreach ($name in $secrets.Keys) {
        $preview = $secrets[$name].Substring(0, [Math]::Min(8, $secrets[$name].Length)) + "..."
        Write-Status "  $name = $preview" "Gray"
    }
    Write-Host ""
    Write-Status "DRY RUN complete. No changes made." "Yellow"
    exit 0
}

# Step 4: Setup ephemeral runner
Write-Step "Setup ephemeral runner"

$runId = -join ((48..57) + (97..102) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
$runnerLabel = "hydrate-secrets-$runId"
$runnerDir = Join-Path (Get-Location) "_runner-hydrate"

Write-Status "Runner label: $runnerLabel" "White"
Write-Status "Runner directory: $runnerDir" "Gray"

# Clean any previous run
if (Test-Path $runnerDir) {
    Write-Status "Cleaning previous runner directory..." "Gray"
    Remove-Item $runnerDir -Recurse -Force
}

Install-Runner $runnerDir

# Get registration token
Write-Status "Getting registration token..." "Gray"
$regToken = Get-RegistrationToken $repoSlug

# Configure
$repoUrl = "https://github.com/$repoSlug"
$runnerName = "hydrate-$runId"

Write-Status "Configuring runner (ephemeral, one-job)..." "Gray"

$configExe = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    Join-Path $runnerDir "config.cmd"
} else {
    Join-Path $runnerDir "config.sh"
}

$configArgs = @(
    "--url", $repoUrl,
    "--token", $regToken,
    "--name", $runnerName,
    "--labels", $runnerLabel,
    "--work", "_work",
    "--ephemeral",
    "--replace",
    "--unattended"
)

if ($IsWindows -or $env:OS -eq "Windows_NT") {
    & $configExe @configArgs
} else {
    & bash $configExe @configArgs
}

if ($LASTEXITCODE -ne 0) {
    Write-Status "Runner configuration failed." "Red"
    exit 1
}

Write-Status "Runner configured." "Green"

# Step 5: Dispatch workflow
Write-Step "Dispatch workflow"
Write-Status "Dispatching hydrate-secrets.yml with label: $runnerLabel" "White"

& gh workflow run "hydrate-secrets.yml" --repo $repoSlug --field "runner_label=$runnerLabel"

if ($LASTEXITCODE -ne 0) {
    Write-Status "Failed to dispatch workflow." "Red"
    Write-Status "Cleaning up runner..." "Gray"
    if (Test-Path $runnerDir) { Remove-Item $runnerDir -Recurse -Force }
    exit 1
}

Write-Status "Workflow dispatched. Runner will pick it up shortly." "Green"

# Step 6: Start runner with secrets in environment
Write-Step "Start ephemeral runner"
Write-Status "Starting runner (will process one job then exit)..." "White"
Write-Status "Waiting for GitHub to queue the hydrate-secrets job..." "Gray"

$runExe = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    Join-Path $runnerDir "run.cmd"
} else {
    Join-Path $runnerDir "run.sh"
}

# Inject secrets into runner process environment
foreach ($name in $secrets.Keys) {
    [Environment]::SetEnvironmentVariable($name, $secrets[$name], "Process")
}

try {
    if ($IsWindows -or $env:OS -eq "Windows_NT") {
        & $runExe
    } else {
        & bash $runExe
    }
}
catch {
    Write-Status "Runner exited with error: $($_.Exception.Message)" "Yellow"
}

# Step 7: Cleanup
Write-Step "Cleanup"
if (Test-Path $runnerDir) {
    Write-Status "Removing runner directory..." "Gray"
    Remove-Item $runnerDir -Recurse -Force
}

Write-Host ""
Write-Status "Done. Secrets have been hydrated to $repoSlug." "Green"
Write-Status "Verify with: gh secret list --repo $repoSlug" "Gray"
Write-Host ""
