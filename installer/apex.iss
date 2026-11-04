; Apex per-user Windows setup. Build it with "bun run build:installer <version>" (scripts/build-installer.mjs),
; which stages the packed package with its locked dependencies and passes both defines below. The version lives in
; the release tag, never in this file.
#ifndef AppVersion
  #error Pass the release version: ISCC /DAppVersion=X.Y.Z /DStageDir=<folder> installer\apex.iss (bun run build:installer X.Y.Z)
#endif
#ifndef StageDir
  #error Pass the staged package folder: ISCC /DAppVersion=X.Y.Z /DStageDir=<folder> installer\apex.iss (bun run build:installer X.Y.Z)
#endif

[Setup]
AppId={{F4E2BAF6-9DFA-4FE8-89CD-4F9CE5E5C11C}
AppName=Apex
AppVersion={#AppVersion}
AppVerName=Apex {#AppVersion}
AppPublisher=Apex contributors
AppPublisherURL=https://github.com/ataberkus/apex
AppSupportURL=https://github.com/ataberkus/apex/issues
AppUpdatesURL=https://github.com/ataberkus/apex/releases
VersionInfoVersion={#AppVersion}
; Per user, no administrator: %LOCALAPPDATA%\Programs\Apex. %LOCALAPPDATA%\Apex is left to the user's rg.exe/fd.exe
; (README) and the dashboard's own state, which uninstalling never touches.
PrivilegesRequired=lowest
DefaultDirName={userpf}\Apex
DefaultGroupName=Apex
DisableProgramGroupPage=yes
; Bun runs on Windows 10 1809 and later.
MinVersion=10.0.17763
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=apex-setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Broadcasts WM_SETTINGCHANGE after installing, so the optional PATH entry reaches windows opened from Explorer.
ChangesEnvironment=yes
UninstallDisplayName=Apex
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create an Apex Dashboard shortcut on the desktop"; GroupDescription: "Shortcuts:"
Name: "addtopath"; Description: "Add the ""apex"" command to my PATH (for cmd in any folder)"; GroupDescription: "Command line:"; Flags: unchecked

; An upgrade clears every staged top-level folder first, so no file of an older version survives in it.
; scripts/build-installer.mjs refuses to build unless this list matches the staged folders exactly.
[InstallDelete]
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\dashboard"
Type: filesandordirs; Name: "{app}\evals"
Type: filesandordirs; Name: "{app}\evolve"
Type: filesandordirs; Name: "{app}\extensions"
Type: filesandordirs; Name: "{app}\lib"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\prompts"
Type: filesandordirs; Name: "{app}\research"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\skills"
Type: filesandordirs; Name: "{app}\templates"
Type: filesandordirs; Name: "{app}\tests"
Type: filesandordirs; Name: "{app}\validation"

[Files]
; The packed package (the release tarball's files, version stamped) with node_modules from bun.lock.
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; The cmd launchers are not in the package; bin\apex.cmd runs bin\apex on the folder it is started in.
Source: "..\bin\apex.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\dashboard.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Apex Dashboard"; Filename: "{app}\dashboard.bat"; WorkingDir: "{app}"; Comment: "Start the Apex web dashboard in your browser"
; Terminal Apex works on its start folder, so it starts in the user folder rather than the install folder.
Name: "{group}\Apex"; Filename: "{app}\bin\apex.cmd"; WorkingDir: "{%USERPROFILE}"; Comment: "Terminal Apex in your user folder"
Name: "{group}\Uninstall Apex"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Apex Dashboard"; Filename: "{app}\dashboard.bat"; WorkingDir: "{app}"; Comment: "Start the Apex web dashboard in your browser"; Tasks: desktopicon

[Code]
{ The PATH task edits HKCU\Environment exactly like install-apex.bat: the value kind is kept, so %VAR% entries
  survive (setx would truncate the value at 1024 characters), entries compare expanded, without trailing
  backslashes and ignoring case, and WM_SETTINGCHANGE is broadcast afterwards. The uninstaller removes only the
  entries naming this install's bin folder and keeps every other byte of the value. }
const
  WM_SETTINGCHANGE = $001A;
  SMTO_ABORTIFHUNG = $0002;
  BunMissing = 'Apex needs Bun 1.4.3 or newer on PATH: https://bun.sh';

var
  BunFound: Boolean;

function ExpandEnvironmentStrings(lpSrc: String; lpDst: String; nSize: DWORD): DWORD;
  external 'ExpandEnvironmentStringsW@kernel32.dll stdcall';

function SendMessageTimeout(hWnd: HWND; Msg: Cardinal; wParam: Longint; lParam: String;
  fuFlags, uTimeout: Cardinal; var lpdwResult: Cardinal): Cardinal;
  external 'SendMessageTimeoutW@user32.dll stdcall';

function ExpandEnvVars(const Value: String): String;
var
  Buffer: String;
  Size: DWORD;
begin
  Result := Value;
  Size := ExpandEnvironmentStrings(Value, #0, 0);
  if Size = 0 then Exit;
  SetLength(Buffer, Size);
  if ExpandEnvironmentStrings(Value, Buffer, Size) <> 0 then
    Result := Copy(Buffer, 1, Size - 1);
end;

function TrimBackslashes(const Value: String): String;
begin
  Result := Value;
  while (Length(Result) > 0) and (Result[Length(Result)] = '\') do
    SetLength(Result, Length(Result) - 1);
end;

function BinDir(): String;
begin
  Result := TrimBackslashes(ExpandConstant('{app}\bin'));
end;

function IsBinEntry(const Entry: String): Boolean;
begin
  Result := CompareText(TrimBackslashes(ExpandEnvVars(Entry)), BinDir()) = 0;
end;

{ Splits on ';' keeping empty segments, so a rewrite can keep the rest of the value as it was. }
procedure SplitPath(const Value: String; Parts: TStringList);
var
  Rest: String;
  Index: Integer;
begin
  Parts.Clear;
  Rest := Value;
  Index := Pos(';', Rest);
  while Index > 0 do
  begin
    Parts.Add(Copy(Rest, 1, Index - 1));
    Rest := Copy(Rest, Index + 1, Length(Rest));
    Index := Pos(';', Rest);
  end;
  Parts.Add(Rest);
end;

function JoinPath(Parts: TStringList): String;
var
  Index: Integer;
begin
  Result := '';
  for Index := 0 to Parts.Count - 1 do
  begin
    if Index > 0 then Result := Result + ';';
    Result := Result + Parts[Index];
  end;
end;

procedure BroadcastEnvironmentChange();
var
  Ignored: Cardinal;
begin
  SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 'Environment', SMTO_ABORTIFHUNG, 5000, Ignored);
end;

procedure AddBinToUserPath();
var
  Raw: String;
  Parts, Kept: TStringList;
  Index: Integer;
  Exists, Present, Written: Boolean;
begin
  Raw := '';
  Exists := RegValueExists(HKEY_CURRENT_USER, 'Environment', 'Path');
  if Exists and not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Raw) then
  begin
    { Not a string value: leave it alone rather than replace it. }
    SuppressibleMsgBox('Could not update the user PATH. Add "' + BinDir() + '" to it manually (Settings, "Edit environment variables for your account").',
      mbError, MB_OK, IDOK);
    Exit;
  end;
  Parts := TStringList.Create;
  Kept := TStringList.Create;
  try
    SplitPath(Raw, Parts);
    Present := False;
    for Index := 0 to Parts.Count - 1 do
      if Parts[Index] <> '' then
      begin
        if IsBinEntry(Parts[Index]) then Present := True;
        Kept.Add(Parts[Index]);
      end;
    if Present then
      Log('Already on the user PATH: ' + BinDir())
    else
    begin
      Kept.Add(BinDir());
      { RegWriteStringValue keeps an existing REG_EXPAND_SZ; a new value is REG_EXPAND_SZ as in install-apex.bat. }
      if Exists then
        Written := RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', JoinPath(Kept))
      else
        Written := RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', JoinPath(Kept));
      if Written then
        Log('Added to the user PATH: ' + BinDir())
      else
        SuppressibleMsgBox('Could not update the user PATH. Add "' + BinDir() + '" to it manually (Settings, "Edit environment variables for your account").',
          mbError, MB_OK, IDOK);
    end;
  finally
    Kept.Free;
    Parts.Free;
  end;
end;

procedure RemoveBinFromUserPath();
var
  Raw: String;
  Parts, Kept: TStringList;
  Index: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Raw) then Exit;
  Parts := TStringList.Create;
  Kept := TStringList.Create;
  try
    SplitPath(Raw, Parts);
    for Index := 0 to Parts.Count - 1 do
      if (Parts[Index] = '') or not IsBinEntry(Parts[Index]) then Kept.Add(Parts[Index]);
    if Kept.Count < Parts.Count then
    begin
      if RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', JoinPath(Kept)) then
      begin
        Log('Removed from the user PATH: ' + BinDir());
        BroadcastEnvironmentChange();
      end
      else
        Log('Could not remove ' + BinDir() + ' from the user PATH');
    end;
  finally
    Kept.Free;
    Parts.Free;
  end;
end;

function PreflightHint(): String;
begin
  Result := 'run "bun run preflight:windows" in ' + ExpandConstant('{app}') + ' to check the setup.';
end;

{ The same check as start.bat and dashboard.bat. }
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  BunFound := Exec(ExpandConstant('{cmd}'), '/c where bun >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not BunFound then Log(BunMissing);
  Result := True;
end;

procedure AddMemoSection(var Memo: String; const Section, NewLine: String);
begin
  if Section = '' then Exit;
  if Memo <> '' then Memo := Memo + NewLine + NewLine;
  Memo := Memo + Section;
end;

{ An upgrade skips the folder page, so any section may be empty. }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := '';
  AddMemoSection(Result, MemoDirInfo, NewLine);
  AddMemoSection(Result, MemoTasksInfo, NewLine);
  if not BunFound then
    AddMemoSection(Result, 'Warning:' + NewLine + Space + BunMissing + NewLine + Space + 'After installing it, ' + PreflightHint(), NewLine);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then AddBinToUserPath();
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Text: String;
begin
  if CurPageID <> wpFinished then Exit;
  Text := 'Apex is installed in ' + ExpandConstant('{app}') + '. The Apex Dashboard shortcut starts the web dashboard; Apex in the Start menu runs terminal Apex in your user folder.' + #13#10#13#10;
  if WizardIsTaskSelected('addtopath') then
    Text := Text + 'Open a new cmd window, cd into a project folder and type "apex" (try "apex --apex-help").' + #13#10#13#10;
  if BunFound then
    Text := Text + 'Before the first start, ' + PreflightHint() + #13#10#13#10
  else
    Text := Text + BunMissing + #13#10 + 'After installing it, ' + PreflightHint() + #13#10#13#10;
  Text := Text + 'Apex also needs Git for Windows and ripgrep (rg.exe) and fd (fd.exe) on your PATH. Setup does not install them; README.md in the Apex folder lists them.';
  WizardForm.FinishedLabel.Caption := Text;
  WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then RemoveBinFromUserPath();
end;
