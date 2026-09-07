@echo off
setlocal
cd /d "%~dp0.."

where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%CD%\start_password_slips.py" %*
    exit /b %ERRORLEVEL%
)

python "%CD%\start_password_slips.py" %*
exit /b %ERRORLEVEL%
