# Rebuild the website data and upload it to Cloudflare R2 (see docs/DEPLOY_CLOUDFLARE.md).
# Uses R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET from the environment and
# asks for any that are missing.
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

# Ask for any R2 setting that is not in the environment. Values typed here live only in this
# PowerShell window; the secret is read without showing it on screen.
$ask = [ordered]@{
    R2_ACCOUNT_ID = "Cloudflare Account ID";
    R2_BUCKET = "R2 bucket name";
    R2_ACCESS_KEY_ID = "R2 Access Key ID";
    R2_SECRET_ACCESS_KEY = "R2 Secret Access Key (hidden while typing)"
}
foreach ($name in $ask.Keys) {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
        if ($name -eq "R2_SECRET_ACCESS_KEY") {
            $sec = Read-Host -Prompt $ask[$name] -AsSecureString
            $val = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
        } else {
            $val = Read-Host -Prompt $ask[$name]
        }
        if (-not $val.Trim()) { throw "$name is needed" }
        [Environment]::SetEnvironmentVariable($name, $val.Trim(), "Process")
    }
}

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
