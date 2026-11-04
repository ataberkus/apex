@echo off
rem Starts the Apex web dashboard ("bun run dashboard") from this checkout and opens it in the browser.
setlocal
set "SELF=%~f0"
cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

where bun >nul 2>&1
if errorlevel 1 goto :no_bun

bun run dashboard
set "RC=%ERRORLEVEL%"
goto :finish

:cd_failed
echo Could not change to the Apex folder: %~dp0
set "RC=1"
goto :finish

:no_bun
echo Apex needs Bun 1.4.3 or newer on PATH: https://bun.sh
echo After installing it, run "bun run preflight:windows" in this folder to check the setup.
set "RC=1"

:finish
if not "%RC%"=="0" call :pause_if_double_clicked
exit /b %RC%

:pause_if_double_clicked
rem Explorer runs: cmd.exe /c ""<full path>" " -- only then pause so the error stays readable.
setlocal EnableDelayedExpansion
set "CL=!cmdcmdline:"=!"
if /i "!CL:*/c %SELF%=!"==" " pause
exit /b 0
