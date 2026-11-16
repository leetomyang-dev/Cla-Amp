@echo off
rem Starts Cla-Amp. The first time, it also fetches what Cla-Amp needs.
setlocal
cd /d "%~dp0"
title Cla-Amp

rem Already set up: just start.
if exist "node_modules\electron\dist\electron.exe" goto start

echo.
echo  Cla-Amp - first start
echo  -----------------------
echo  This sets Cla-Amp up in this folder. It is done once.
echo.

where npm >nul 2>nul
if errorlevel 1 goto nonode

echo  Downloading what Cla-Amp needs (the window it runs in and Claude Code).
echo  This is a few hundred megabytes and can take some minutes. Leave this
echo  window open until it says it is done.
echo.
call npm install
if errorlevel 1 goto failed
if not exist "node_modules\electron\dist\electron.exe" goto failed

echo.
echo  Done. Starting Cla-Amp. From now on a double-click starts it at once.
goto start

:start
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:nonode
echo  Cla-Amp needs Node.js, a free program, to set itself up.
echo  It was not found on this computer.
echo.
where winget >nul 2>nul
if errorlevel 1 goto nodepage
choice /c YN /n /m "  Install Node.js now, with Windows' own installer (winget)? [Y/N] "
if errorlevel 2 goto nodepage
echo.
winget install -e --id OpenJS.NodeJS.LTS
if errorlevel 1 goto nodepage
echo.
echo  Node.js is installed. Close this window and double-click Cla-Amp.bat
echo  again to finish the set-up.
echo.
pause
exit /b 0

:nodepage
echo.
echo  Get Node.js from its own site: https://nodejs.org  (choose the LTS
echo  version and keep the installer's standard choices). Then double-click
echo  Cla-Amp.bat again.
echo.
choice /c YN /n /m "  Open that page in your browser now? [Y/N] "
if errorlevel 2 exit /b 1
start "" "https://nodejs.org/en/download"
exit /b 1

:failed
echo.
echo  The set-up did not finish. Check the internet connection and double-click
echo  Cla-Amp.bat again. If it keeps failing, the lines above say why; the
echo  project's Issues page on GitHub is the place to ask.
echo.
pause
exit /b 1
