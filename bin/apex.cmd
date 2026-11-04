@echo off
rem "apex" for cmd: with this folder on PATH (install-apex.bat adds it), "apex" runs terminal Apex on the
rem folder you are in. The shim never changes folder and passes every argument to bin/apex unchanged.
setlocal
where bun >nul 2>&1
if errorlevel 1 goto :no_bun
bun "%~dp0apex" %*
exit /b %ERRORLEVEL%

:no_bun
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
echo Apex needs Bun 1.4.3 or newer on PATH: https://bun.sh 1>&2
echo After installing it, run "bun run preflight:windows" in %ROOT% to check the setup. 1>&2
exit /b 1
