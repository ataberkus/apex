@echo off
rem Starts Apex from this checkout: "start.bat" runs terminal Apex, "start.bat dashboard" the dashboard,
rem any other arguments go to "bun bin/apex" unchanged.
setlocal
set "SELF=%~f0"
cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

where bun >nul 2>&1
if errorlevel 1 goto :no_bun

if /i "%~1"=="dashboard" goto :dashboard
bun bin/apex %*
goto :done

:dashboard
bun run dashboard
goto :done

:cd_failed
echo Could not change to the Apex folder: %~dp0
set "RC=1"
goto :finish

:no_bun
echo Apex needs Bun 1.4.3 or newer on PATH: https://bun.sh
echo After installing it, run "bun run preflight:windows" in this folder to check the setup.
set "RC=1"
goto :finish

:done
set "RC=%ERRORLEVEL%"

:finish
if not "%RC%"=="0" call :pause_if_double_clicked
exit /b %RC%

:pause_if_double_clicked
rem Explorer runs: cmd.exe /c ""<full path>" " -- only then pause so the error stays readable.
setlocal EnableDelayedExpansion
set "CL=!cmdcmdline:"=!"
if /i "!CL:*/c %SELF%=!"==" " pause
exit /b 0
