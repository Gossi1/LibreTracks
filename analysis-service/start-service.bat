@echo off
rem Starts the loopback MIR analysis service on http://127.0.0.1:8799
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo The venv is missing - run install.bat first.
  pause
  exit /b 1
)

.venv\Scripts\python.exe server.py
pause
