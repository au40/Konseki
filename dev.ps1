# Launches the tracker against an isolated dev data folder.
# Your real data at ~/immersion-tracker/ is untouched.
#
# Usage:
#   .\dev.ps1            launch with existing dev data
#   .\dev.ps1 -Fresh     wipe dev data first (fresh install simulation)

param(
    [switch]$Fresh
)

$env:IMMERSION_TRACKER_DATA_DIR = Join-Path $PSScriptRoot "dev-data"

if ($Fresh) {
    if (Test-Path $env:IMMERSION_TRACKER_DATA_DIR) {
        Remove-Item $env:IMMERSION_TRACKER_DATA_DIR -Recurse -Force
        Write-Host "Wiped dev-data/" -ForegroundColor Yellow
    }
}

Write-Host "Data dir: $env:IMMERSION_TRACKER_DATA_DIR" -ForegroundColor Cyan
python (Join-Path $PSScriptRoot "src\tracker.py")
