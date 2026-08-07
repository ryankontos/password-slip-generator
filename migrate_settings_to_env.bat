@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "EXIT_CODE=1"

where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
    if not errorlevel 1 (
        py -3 src\migrate_settings_to_env.py %*
        set "EXIT_CODE=!ERRORLEVEL!"
        goto :finish
    )
)

where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
    if not errorlevel 1 (
        python src\migrate_settings_to_env.py %*
        set "EXIT_CODE=!ERRORLEVEL!"
        goto :finish
    )
)

echo Python 3.9 or newer is required.
echo Install Python from https://www.python.org/downloads/windows/ and select "Add Python to PATH".

:finish
if not "%PASSWORD_SLIPS_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
