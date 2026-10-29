@echo off
title LibreTracks (with WorshipTools)
cd /d "C:\LibreTracks"

set "PATH=%USERPROFILE%\.cargo\bin;%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.20.0-win-x64;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Kitware.CMake_Microsoft.Winget.Source_8wekyb3d8bbwe\cmake-4.4.4-windows-x86_64\bin;%PATH%"
set "LIBRETRACKS_ENGINE_V2_FFMPEG=1"

echo ===================================================
echo   Starting LibreTracks (Native Audio Engine v2)
echo   Commit: 5a142070 (WorshipTools + CCLI Rehearse)
echo ===================================================
echo.

node ./scripts/desktop-native.mjs dev

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] LibreTracks exited with error code %ERRORLEVEL%.
    pause
)
