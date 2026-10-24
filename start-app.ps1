$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 1
    if ($health.ok) {
        Write-Host "WeiGuang is already running. Opening http://127.0.0.1:8000 ..." -ForegroundColor Green
        Start-Process "http://127.0.0.1:8000"
        exit
    }
} catch {
    # Not running yet: continue and start the server.
}

$bundled = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\python\python.exe"
$python = if (Test-Path -LiteralPath $bundled) { $bundled } else { "python" }

Write-Host ""
Write-Host "  WeiGuang / 微光" -ForegroundColor Green
Write-Host "  http://127.0.0.1:8000" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

& $python "$PSScriptRoot\app.py" --open
