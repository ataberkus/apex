# Runner preparation: rg/fd for the preflight, Defender real-time scanning back on (hosted images turn it off, a developer
# machine has it on), and a machine record in results/machine.json.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force results | Out-Null
choco install ripgrep fd -y --no-progress | Select-Object -Last 2
$before = try { (Get-MpPreference).ExclusionPath } catch { @() }
try {
  if ($before) { Remove-MpPreference -ExclusionPath $before -ErrorAction Stop }
  Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction Stop
  'defender: real-time monitoring requested on, exclusions removed'
} catch { "defender: could not change: $($_.Exception.Message)" }
Start-Sleep -Seconds 5
$mp = try { Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, OnAccessProtectionEnabled, IsTamperProtected } catch { "Get-MpComputerStatus failed: $($_.Exception.Message)" }
$info = [ordered]@{
  os = "$((Get-CimInstance Win32_OperatingSystem).Caption) $([Environment]::OSVersion.Version)"
  cpus = [Environment]::ProcessorCount
  cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
  ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  bun = "$(bun --version)"
  git = "$(git --version)"
  rg = "$(rg --version | Select-Object -First 1)"
  fd = "$(fd --version)"
  executionPolicy = "$(Get-ExecutionPolicy)"
  autocrlf = "$(git config --get core.autocrlf)"
  defenderExclusionsBefore = @($before)
  defenderExclusionsAfter = @(try { (Get-MpPreference).ExclusionPath } catch { 'unreadable' })
  defender = $mp
}
$info | ConvertTo-Json -Depth 4 | Tee-Object -FilePath results/machine.json
exit 0
