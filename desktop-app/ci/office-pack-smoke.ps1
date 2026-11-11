# Smoke test of one built AeroGyan Office PACK installer (OFFICE_PACK=<id>), on the Windows runner:
#   1. the installer is a Windows program; the unpacked app's self-test opens /apps/<slug>/ with the pack's user-agent
#   2. silent per-user install (no admin) → Settings › Apps lists the pack
#   3. Start menu folder "<pack name>" has one shortcut per app: right program, --office=<slug>, its own .ico,
#      its own AppUserModelID tech.aerogyan.pack.<id>.<slug>; desktop shortcuts only for the first 4 apps
#   4. launching two different shortcuts opens two windows (one program) on the right /apps/<slug>/ pages,
#      and launching the first again only focuses it
#   5. silent uninstall removes the program, every shortcut, the folder and the Settings entry
# Writes selftest\pack\smoke.txt (+ the self-test's report.txt). Exit 1 when a check of steps 2–5 fails.
$ErrorActionPreference = 'Continue'
$out = Join-Path $PWD 'selftest\pack'
New-Item -ItemType Directory -Force $out | Out-Null
$r = New-Object System.Collections.Generic.List[string]
$script:fails = 0
function Pass($m) { $r.Add("PASS  $m") }
function Fail($m) { $r.Add("FAIL  $m"); $script:fails++ }
function Info($m) { $r.Add("info  $m") }
function WinName([string]$s) { (($s -replace '[^A-Za-z0-9 ]', '') -replace '\s+', ' ').Trim() }

$packId = $env:OFFICE_PACK
$data = Get-Content -Raw -Encoding UTF8 'office\apps.json' | ConvertFrom-Json
$pack = $data.packs | Where-Object { $_.id -eq $packId } | Select-Object -First 1
$apps = @($pack.apps | ForEach-Object { $s = $_; $data.apps | Where-Object { $_.slug -eq $s } | Select-Object -First 1 })
$name = $pack.name
$folderName = WinName $name
$exeName = (WinName $name) + '.exe'
Info "pack $packId '$name' — $($apps.Count) apps: $(($apps | ForEach-Object { $_.slug }) -join ', ')"

function Read-Report($file) {
  try { if (Test-Path -LiteralPath $file) { return (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) } } catch {}
  return $null
}
function Wait-Report($file, [scriptblock]$ok, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $rep = Read-Report $file
    if ($rep -and (& $ok $rep)) { return $rep }
    Start-Sleep -Milliseconds 500
  }
  return (Read-Report $file)
}
function Main-Processes {
  @(Get-CimInstance Win32_Process -Filter "Name='$exeName'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -notmatch '--type=' })
}
function Stop-Pack {
  Get-Process | Where-Object { $_.Path -and $_.Path -like "$env:LOCALAPPDATA\Programs\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

try {
  # ---- 1. the installer + the unpacked app
  $setup = Get-ChildItem 'desktop-app\dist\AeroGyan-*-Setup-*.exe' | Select-Object -First 1
  if (-not $setup) { Fail 'installer built' } else {
    $b = [IO.File]::ReadAllBytes($setup.FullName)
    if ($b[0] -eq 0x4D -and $b[1] -eq 0x5A) { Pass "installer $($setup.Name) — $([math]::Round($setup.Length / 1MB, 1)) MB, MZ header" } else { Fail 'installer is not a Windows program' }
  }
  $unpacked = Join-Path 'desktop-app\dist\win-unpacked' $exeName
  if (Test-Path -LiteralPath $unpacked) {
    # a shared app (Sheets …) is live for every account; for the student pack that is its first app
    $test = ($apps | Where-Object { $_.audience -eq 'both' } | Select-Object -First 1).slug
    if (-not $test) { $test = $apps[1].slug }
    $p = Start-Process -FilePath (Resolve-Path -LiteralPath $unpacked).Path -ArgumentList "--office=$test", "--aero-selftest=$out" -PassThru
    if (-not $p.WaitForExit(200000)) { Stop-Process -Id $p.Id -Force; Info 'self-test killed after 200 s' }
    Info "self-test of the unpacked app with --office=$test (see report below)"
    $icons = @(Get-ChildItem 'desktop-app\dist\win-unpacked\resources\office-icons' -Filter '*.ico' -ErrorAction SilentlyContinue)
    if ($icons.Count -eq $apps.Count) { Pass "$($icons.Count) app icons (.ico) in resources\office-icons" } else { Fail "app icons in resources\office-icons — $($icons.Count) for $($apps.Count) apps" }
  } else { Fail "unpacked program $unpacked" }
  if (-not $setup) { throw 'no installer' }

  # ---- 2. silent install
  $t = [Diagnostics.Stopwatch]::StartNew()
  $p2 = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -PassThru
  if ($p2.WaitForExit(240000)) { Pass "silent install without admin — $([math]::Round($t.Elapsed.TotalSeconds,1)) s, exit $($p2.ExitCode)" } else { Fail 'silent install finished in time' }
  Start-Sleep -Seconds 3
  Stop-Pack
  $un = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1
  if ($un) { Pass "listed in Settings › Apps as '$($un.DisplayName)' $($un.DisplayVersion)" } else { Fail "listed in Settings › Apps as '$name'" }
  $exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter $exeName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) { Pass "installed to $($exe.FullName)" } else { Fail "$exeName under %LOCALAPPDATA%\Programs"; throw 'not installed' }
  $instDir = $exe.DirectoryName

  # ---- 3. shortcuts
  $wsh = New-Object -ComObject WScript.Shell
  $shell = New-Object -ComObject Shell.Application
  $smDir = Join-Path ([Environment]::GetFolderPath('Programs')) $folderName
  $desk = [Environment]::GetFolderPath('Desktop')
  if (Test-Path -LiteralPath $smDir) { Pass "Start-menu folder '$folderName'" } else { Fail "Start-menu folder '$smDir'" }
  $links = @(Get-ChildItem -LiteralPath $smDir -Filter '*.lnk' -ErrorAction SilentlyContinue)
  if ($links.Count -eq $apps.Count) { Pass "$($links.Count) Start-menu shortcuts for $($apps.Count) apps" } else { Fail "Start-menu shortcuts — $($links.Count) for $($apps.Count) apps: $(($links | ForEach-Object { $_.Name }) -join ', ')" }
  $aumids = @{}
  $i = 0
  foreach ($a in $apps) {
    $lnkName = (WinName $a.name) + '.lnk'
    $lnk = Join-Path $smDir $lnkName
    if (-not (Test-Path -LiteralPath $lnk)) { Fail "Start menu › $folderName › $lnkName"; $i++; continue }
    $sc = $wsh.CreateShortcut($lnk)
    $iconFile = ($sc.IconLocation -replace ',\s*-?\d+$', '')
    $aumid = ''
    try { $aumid = [string]$shell.Namespace($smDir).ParseName($lnkName).ExtendedProperty('System.AppUserModel.ID') } catch {}
    $want = "tech.aerogyan.pack.$packId.$($a.slug)"
    $problems = @()
    if ($sc.TargetPath -ne $exe.FullName) { $problems += "target '$($sc.TargetPath)'" }
    if ($sc.Arguments -ne "--office=$($a.slug)") { $problems += "arguments '$($sc.Arguments)'" }
    if (-not (Test-Path -LiteralPath $iconFile) -or -not $iconFile.EndsWith("\$($a.slug).ico")) { $problems += "icon '$($sc.IconLocation)'" }
    if ($aumid -ne $want) { $problems += "AppUserModelID '$aumid'" }
    if ($problems.Count) { Fail "shortcut $lnkName — $($problems -join '; ')" } else { Pass "shortcut $lnkName → --office=$($a.slug), icon $($a.slug).ico, AUMID $aumid" }
    $aumids[$aumid] = 1
    $dl = Join-Path $desk $lnkName
    if ($i -lt 4) {
      if (Test-Path -LiteralPath $dl) {
        $ds = $wsh.CreateShortcut($dl)
        if ($ds.Arguments -eq "--office=$($a.slug)") { Pass "desktop shortcut $lnkName" } else { Fail "desktop shortcut $lnkName — arguments '$($ds.Arguments)'" }
      } else { Fail "desktop shortcut $lnkName" }
    } elseif (Test-Path -LiteralPath $dl) { Fail "no desktop shortcut for app $($i + 1) ($lnkName)" }
    $i++
  }
  if ($aumids.Count -eq $apps.Count) { Pass 'every shortcut has its own AppUserModelID' } else { Fail "own AppUserModelIDs — $($aumids.Count) different for $($apps.Count) apps" }
  if (Test-Path 'HKCU:\Software\Classes\aerogyan') { Fail 'aerogyan:// links taken from the main app' } else { Pass 'aerogyan:// links left to the main app' }

  # ---- 4. two shortcuts → two windows of one program
  $ud = Join-Path $env:APPDATA $name
  New-Item -ItemType Directory -Force $ud | Out-Null
  Set-Content (Join-Path $ud 'ci-report.on') '1'
  $rep = Join-Path $ud 'ci-report.json'
  Remove-Item -LiteralPath $rep -ErrorAction SilentlyContinue
  $a1 = $apps[0]; $a2 = $apps[$apps.Count - 1]
  $l1 = Join-Path $smDir ((WinName $a1.name) + '.lnk'); $l2 = Join-Path $smDir ((WinName $a2.name) + '.lnk')
  $url1 = "https://aerogyan.tech/apps/$($a1.slug)/"; $url2 = "https://aerogyan.tech/apps/$($a2.slug)/"
  Start-Process -FilePath $l1
  $s1 = Wait-Report $rep { param($x) @($x.windows | Where-Object { $_.slug -eq $a1.slug -and $_.url -like "$url1*" }).Count -eq 1 } 60
  if ($s1 -and @($s1.windows | Where-Object { $_.slug -eq $a1.slug -and $_.url -like "$url1*" }).Count -eq 1) { Pass "shortcut '$($a1.name)' opens a window on $(($s1.windows | Where-Object { $_.slug -eq $a1.slug }).url)" }
  else { Fail "shortcut '$($a1.name)' opens $url1 — report: $(if ($s1) { $s1 | ConvertTo-Json -Compress -Depth 4 } else { 'none' })" }
  if ($s1 -and $s1.ua -like "*(Desktop; Windows; Office pack $packId)*") { Pass "user-agent '… (Desktop; Windows; Office pack $packId)'" } else { Fail "user-agent names the pack — $($s1.ua)" }
  Start-Sleep -Seconds 2
  Start-Process -FilePath $l2
  $s2 = Wait-Report $rep { param($x) @($x.windows | Where-Object { $_.slug -eq $a2.slug -and $_.url -like "$url2*" }).Count -eq 1 } 60
  $w1 = @($s2.windows | Where-Object { $_.slug -eq $a1.slug -and $_.url -like "$url1*" })
  $w2 = @($s2.windows | Where-Object { $_.slug -eq $a2.slug -and $_.url -like "$url2*" })
  if ($s2 -and @($s2.windows).Count -eq 2 -and $w1.Count -eq 1 -and $w2.Count -eq 1) { Pass "shortcut '$($a2.name)' opens a second window on $($w2[0].url) (both open)" }
  else { Fail "two windows on $url1 and $url2 — report: $(if ($s2) { $s2 | ConvertTo-Json -Compress -Depth 4 } else { 'none' })" }
  if ($w1.Count -eq 1 -and $w2.Count -eq 1 -and $w1[0].appId -ne $w2[0].appId) { Pass "own taskbar ids: $($w1[0].appId) · $($w2[0].appId)" } else { Fail 'each window has its own taskbar id' }
  $procs = Main-Processes
  if ($procs.Count -eq 1) { Pass "one program runs both windows (pid $($procs[0].ProcessId))" } else { Fail "one program for both windows — $($procs.Count) main processes" }
  Start-Process -FilePath $l1
  Start-Sleep -Seconds 4
  $s3 = Read-Report $rep
  if ($s3 -and @($s3.windows).Count -eq 2 -and $s3.why -match 'second-instance|navigated|loaded') { Pass "starting '$($a1.name)' again focuses its window (still 2 windows)" } else { Fail "starting '$($a1.name)' again — $(if ($s3) { $s3 | ConvertTo-Json -Compress -Depth 4 } else { 'none' })" }
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save((Join-Path $out 'pack-windows.png')); $g.Dispose(); $bmp.Dispose()
    Info 'screenshot pack-windows.png (content protection shows the windows black)'
  } catch { Info "screenshot failed — $($_.Exception.Message)" }
  Stop-Pack
  Remove-Item -LiteralPath (Join-Path $ud 'ci-report.on') -ErrorAction SilentlyContinue

  # ---- 5. uninstall
  $cmd = if ($un.QuietUninstallString) { $un.QuietUninstallString } else { "$($un.UninstallString) /S" }
  Info "uninstall: $cmd"
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $uexe = $Matches[1]; $uargs = $Matches[2] } else { $uexe = $cmd; $uargs = '/S' }
  if (-not $uargs) { $uargs = '/S' }
  Start-Process -FilePath $uexe -ArgumentList $uargs -Wait
  $end = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 2
    $still = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name }
  } while ($still -and (Get-Date) -lt $end)
  Start-Sleep -Seconds 3
  if (-not $still) { Pass 'uninstall: gone from Settings › Apps' } else { Fail 'uninstall: still in Settings › Apps' }
  if (-not (Test-Path -LiteralPath $exe.FullName)) { Pass "uninstall: program removed" } else { Fail "uninstall: $($exe.FullName) still there" }
  if (-not (Test-Path -LiteralPath $smDir)) { Pass "uninstall: Start-menu folder '$folderName' removed" } else { Fail "uninstall: Start-menu folder still has $((Get-ChildItem -LiteralPath $smDir | ForEach-Object { $_.Name }) -join ', ')" }
  $left = @($apps | Select-Object -First 4 | Where-Object { Test-Path -LiteralPath (Join-Path $desk ((WinName $_.name) + '.lnk')) })
  if ($left.Count -eq 0) { Pass 'uninstall: desktop shortcuts removed' } else { Fail "uninstall: desktop shortcuts left — $(($left | ForEach-Object { $_.name }) -join ', ')" }
  if (-not (Test-Path "HKCU:\Software\tech.aerogyan.pack.$packId")) { Pass 'uninstall: no registry left-overs' } else { Fail "uninstall: HKCU\Software\tech.aerogyan.pack.$packId left" }
} catch { Fail "smoke test ran — $($_.Exception.Message)" }

$r | Set-Content "$out\smoke.txt"
"=== $name ($packId) ==="
Get-Content "$out\smoke.txt"
if (Test-Path "$out\report.txt") { '--- self-test (unpacked app) ---'; Get-Content "$out\report.txt" }
if ($script:fails -gt 0) { "$($script:fails) check(s) failed"; exit 1 }
exit 0
