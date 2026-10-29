@echo off
rem One-time setup for the "apex" command: appends this checkout's bin folder (which holds apex.cmd) to the
rem user PATH unless it is already there. Afterwards, in a new cmd window, "apex" runs terminal Apex on the
rem current folder.
rem The PATH is edited in the registry (HKCU\Environment) with its value kind kept, so %%VAR%% entries survive;
rem setx would truncate it at 1024 characters. Clearing the unset APEX_PATH_REFRESH variable through
rem [Environment]::SetEnvironmentVariable changes nothing but broadcasts WM_SETTINGCHANGE, so windows opened
rem from Explorer see the new PATH without signing out.
setlocal
set "SELF=%~f0"
for %%I in ("%~dp0bin") do set "APEX_BIN=%%~fI"
if not exist "%APEX_BIN%\apex.cmd" goto :no_shim

where bun >nul 2>&1
if errorlevel 1 echo Warning: Bun is not on PATH yet. Install Bun 1.4.3 or newer before running apex: https://bun.sh

powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $dir=$env:APEX_BIN.TrimEnd('\'); $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $raw=[string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $parts=@($raw.Split(';') | Where-Object { $_ -ne '' }); if (@($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $dir }).Count) { Write-Output ('Already on your user PATH: ' + $dir); exit 0 }; $kind=if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }; $key.SetValue('Path', (($parts + $dir) -join ';'), $kind); $key.Close(); [Environment]::SetEnvironmentVariable('APEX_PATH_REFRESH', $null, 'User'); Write-Output ('Added to your user PATH: ' + $dir)"
if errorlevel 1 goto :ps_failed
echo Open a new cmd window, cd into a project folder and type "apex" (try "apex --apex-help").
set "RC=0"
goto :finish

:no_shim
echo Could not find "%APEX_BIN%\apex.cmd"; run install-apex.bat from the Apex checkout.
set "RC=1"
goto :finish

:ps_failed
echo Could not update the user PATH. Add "%APEX_BIN%" to it manually (Settings, "Edit environment variables for your account").
set "RC=1"

:finish
call :pause_if_double_clicked
exit /b %RC%

:pause_if_double_clicked
rem Explorer runs: cmd.exe /c ""<full path>" " -- only then pause so the result stays readable.
setlocal EnableDelayedExpansion
set "CL=!cmdcmdline:"=!"
if /i "!CL:*/c %SELF%=!"==" " pause
exit /b 0
