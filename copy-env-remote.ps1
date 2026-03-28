# Copy .env to remote COOLMASTER-DESK
$envContent = Get-Content 'C:\game-ci\help-bot\.env' -Raw
Invoke-Command -ComputerName COOLMASTER-DESK -ScriptBlock {
    param($content)
    Set-Content -Path 'C:\game-ci\help-bot\.env' -Value $content -NoNewline
    Write-Output '.env written'
    Get-Content 'C:\game-ci\help-bot\.env' | Where-Object { $_ -match '=' -and -not $_.StartsWith('#') } | ForEach-Object { ($_ -split '=')[0] }
} -ArgumentList $envContent
