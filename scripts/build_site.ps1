# Build the static website for GoDaddy (or any plain web hosting).
# Run from the project folder in PowerShell:   .\scripts\build_site.ps1
# Result: web\dist\  -> upload everything inside it (including the hidden .htaccess) to public_html.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

& .\.venv\Scripts\python.exe -m pipeline.run export-static
if ($LASTEXITCODE -ne 0) { throw "export-static failed" }

Push-Location web
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally { Pop-Location }

$size = (Get-ChildItem web\dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Built web\dist ({0:N1} MB). Zip it and upload to GoDaddy as described in docs\DEPLOY_GODADDY.md" -f $size)
