# Rebuild the website data and upload it to Cloudflare R2 (see docs/DEPLOY_CLOUDFLARE.md).
# Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in the environment.
# Run from the project folder in PowerShell:
#   .\scripts\publish_data.ps1 -Origins https://example.org
#   .\scripts\publish_data.ps1 -SkipExport          # upload what is already in web\public\data
param(
    [string[]]$Origins = @(),
    [switch]$SkipExport,
    [switch]$Delete
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $SkipExport) {
    & .\.venv\Scripts\python.exe -m pipeline.run export-static
    if ($LASTEXITCODE -ne 0) { throw "export-static failed" }
}

$upload = @("scripts\upload_r2.py")
if ($Origins.Count -gt 0) { $upload += "--cors"; $upload += $Origins }
if ($Delete) { $upload += "--delete" }
& .\.venv\Scripts\python.exe @upload
if ($LASTEXITCODE -ne 0) { throw "upload failed" }
Write-Host "Data uploaded. The page itself is built by Cloudflare Pages on every git push."
