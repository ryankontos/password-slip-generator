$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 "$Root\start_password_slips.py" @args
} else {
    & python "$Root\start_password_slips.py" @args
}
exit $LASTEXITCODE
