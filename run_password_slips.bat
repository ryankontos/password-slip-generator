@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "EXIT_CODE=1"

set "VENV_PYTHON=%CD%\.venv\Scripts\python.exe"
if exist "%VENV_PYTHON%" goto :dependencies

where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
    if not errorlevel 1 (
        py -3 -m venv .venv
        if errorlevel 1 set "EXIT_CODE=!ERRORLEVEL!"
        goto :dependencies
    )
)

where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
    if not errorlevel 1 (
        python -m venv .venv
        if errorlevel 1 set "EXIT_CODE=!ERRORLEVEL!"
        goto :dependencies
    )
)

echo Python 3.9 or newer is required.
echo Install Python from https://www.python.org/downloads/windows/ and select "Add Python to PATH".
goto :finish

:dependencies
if not exist "%VENV_PYTHON%" (
    echo Could not create the virtual environment.
    goto :finish
)
"%VENV_PYTHON%" -c "import openpyxl, reportlab" >nul 2>&1
if not errorlevel 1 goto :run
"%VENV_PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 (
    set "EXIT_CODE=!ERRORLEVEL!"
    goto :finish
)

:run
"%VENV_PYTHON%" src\password_slips.py
set "EXIT_CODE=!ERRORLEVEL!"

:finish
if not "%PASSWORD_SLIPS_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
