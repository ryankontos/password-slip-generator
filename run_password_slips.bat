@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 start_password_slips.py %*
) else (
  python start_password_slips.py %*
)
if not "%PASSWORD_SLIPS_NO_PAUSE%"=="1" pause
