# Quick check of one built AeroGyan Office app (OFFICE_SLUG): the installer is a real Windows
# program, the unpacked app opens /apps/<slug>/ and runs its self-test, and a silent per-user
# install lands in Settings › Apps under the app's own name. Never fails the build; writes
# selftest\office\report.txt.
$ErrorActionPreference = 'Continue'
$out = Join-Path $PWD 'selftest\office'
New-Item -ItemType Directory -Force $out | Out-Null
$r = New-Object System.Collections.Generic.List[string]
$slug = $env:OFFICE_SLUG
$name = $env:OFFICE_NAME
try {
  $setup = Get-ChildItem 'desktop-app\dist\AeroGyan-*-Setup-*.exe' | Select-Object -First 1
  if (-not $setup) { $r.Add('FAIL  installer built') } else {
    $b = [IO.File]::ReadAllBytes($setup.FullName)
    if ($b[0] -eq 0x4D -and $b[1] -eq 0x5A) { $r.Add("PASS  installer $($setup.Name) — $([math]::Round($setup.Length / 1MB, 1)) MB, MZ header") } else { $r.Add('FAIL  installer is not a Windows program') }
  }
  $exe = Get-ChildItem 'desktop-app\dist\win-unpacked' -Filter '*.exe' | Select-Object -First 1
  if (-not $exe) { $r.Add('FAIL  unpacked app found') } else {
    $r.Add("PASS  app program '$($exe.Name)'")
    $ver = $exe.VersionInfo
    $r.Add("info  file description '$($ver.FileDescription)' · product '$($ver.ProductName)' $($ver.ProductVersion)")
    $p = Start-Process -FilePath $exe.FullName -ArgumentList "--aero-selftest=$out" -PassThru
    if (-not $p.WaitForExit(200000)) { Stop-Process -Id $p.Id -Force; $r.Add('FAIL  self-test finished in time — killed after 200 s') }
  }
  if ($setup) {
    $t = [Diagnostics.Stopwatch]::StartNew()
    $p2 = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru
    if ($p2.WaitForExit(180000)) { $r.Add("PASS  silent install without admin — $([math]::Round($t.Elapsed.TotalSeconds,1)) s, exit $($p2.ExitCode)") } else { $r.Add('FAIL  silent install finished in time') }
    Start-Sleep -Seconds 3
    Get-Process | Where-Object { $_.Path -and $_.Path -like "$env:LOCALAPPDATA\Programs\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    $un = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1
    if ($un) { $r.Add("PASS  listed in Settings › Apps as '$($un.DisplayName)' $($un.DisplayVersion)") } else { $r.Add("FAIL  listed in Settings › Apps as '$name'") }
    $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"
    if (Test-Path -LiteralPath $desk) { $r.Add('PASS  desktop icon created') } else { $r.Add("FAIL  desktop icon created — missing $desk") }
    if (Test-Path 'HKCU:\Software\Classes\aerogyan') { $r.Add('FAIL  aerogyan:// links taken from the main app') } else { $r.Add('PASS  aerogyan:// links left to the main app') }
  }
} catch { $r.Add("FAIL  smoke test ran — $($_.Exception.Message)") }
$r | Set-Content "$out\smoke.txt"
if (-not (Test-Path "$out\report.txt")) { Set-Content "$out\report.txt" 'FAIL  no self-test report written (app did not start?)' }
"=== $name ($slug) ==="
Get-Content "$out\smoke.txt"
Get-Content "$out\report.txt"
exit 0
