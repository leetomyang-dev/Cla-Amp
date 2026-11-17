@echo off
rem Updates the Cla-Amp in this folder from its official page on GitHub.
rem A folder made with git is updated with git; one made from the ZIP gets
rem the newest ZIP copied over it. Settings, chats and sign-ins are kept
rem elsewhere on the computer and are not touched.
setlocal
cd /d "%~dp0"
title Cla-Amp - update
set "REPO=https://github.com/leetomyang-dev/Cla-Amp"

echo.
echo  Cla-Amp - update
echo  ------------------
echo  This brings the Cla-Amp in this folder up to date from
echo  %REPO%
echo.
echo  Close Cla-Amp first. Files of Cla-Amp that you changed yourself are
echo  replaced by the new ones, so keep a copy of anything you want to keep.
echo.
choice /c YN /n /m "  Update now? [Y/N] "
if errorlevel 2 exit /b 0
echo.

where npm >nul 2>nul
if errorlevel 1 goto nonode

if exist ".git\" goto withgit
goto withzip

:withgit
where git >nul 2>nul
if errorlevel 1 goto nogit
rem This file may itself be replaced by the update, so the rest is one block,
rem which is read whole before any of it runs.
(
  echo  Getting the newest version with git.
  git pull --ff-only
  if errorlevel 1 goto gitfailed
  echo.
  echo  Fetching anything new that Cla-Amp needs.
  call npm install
  if errorlevel 1 goto failed
  echo.
  echo  Done. Start Cla-Amp with Cla-Amp.bat.
  echo.
  pause
  exit /b 0
)

:withzip
where curl.exe >nul 2>nul
if errorlevel 1 goto notools
where tar.exe >nul 2>nul
if errorlevel 1 goto notools
set "WORK=%TEMP%\cla-amp-update"
if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%"
echo  Downloading the newest version.
curl.exe -L --fail --silent --show-error -o "%WORK%\cla-amp.zip" "%REPO%/archive/refs/heads/main.zip"
if errorlevel 1 goto failed
tar.exe -xf "%WORK%\cla-amp.zip" -C "%WORK%"
if errorlevel 1 goto failed
if not exist "%WORK%\Cla-Amp-main\main.mjs" goto failed
rem This file may itself be replaced by the update, so the rest is one block,
rem which is read whole before any of it runs.
(
  echo  Copying it over this folder.
  robocopy "%WORK%\Cla-Amp-main" "%~dp0." /E /XD node_modules .git /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 goto failed
  rmdir /s /q "%WORK%"
  echo.
  echo  Fetching anything new that Cla-Amp needs.
  call npm install
  if errorlevel 1 goto failed
  echo.
  echo  Done. Start Cla-Amp with Cla-Amp.bat.
  echo.
  pause
  exit /b 0
)

:nonode
echo  Node.js was not found. Start Cla-Amp.bat once first: it sets that up.
echo.
pause
exit /b 1

:nogit
echo  This folder was made with git, but git was not found on this computer.
echo  Install git, or download the ZIP again from
echo  %REPO%
echo.
pause
exit /b 1

:notools
echo  This needs curl and tar, which come with Windows 10 and 11. They were not
echo  found. Download the ZIP by hand from
echo  %REPO%
echo  and unzip it over this folder.
echo.
pause
exit /b 1

:gitfailed
echo.
echo  git could not update this folder. If you changed files of Cla-Amp
echo  yourself, the lines above say which ones are in the way.
echo.
pause
exit /b 1

:failed
echo.
echo  The update did not finish. Check the internet connection and try again.
echo  Nothing of your settings or chats is touched by an update. You can also
echo  download the ZIP by hand from
echo  %REPO%
echo  and unzip it over this folder.
echo.
pause
exit /b 1
