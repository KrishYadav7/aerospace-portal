# Smoke test of one built AeroGyan Office PACK installer (OFFICE_PACK=<id>), on the Windows runner:
#   1. the installer is a Windows program; the unpacked app's self-test opens /apps/<slug>/ with the pack's user-agent
#   2. silent per-user install (no admin) → Settings › Apps lists the pack
#   3. shortcuts: Start-menu folder "<pack name>" = the pack's home ("<pack name>", no arguments, the pack's icon
#      and id) + one shortcut per app (--office=<slug>, own .ico, own AppUserModelID tech.aerogyan.pack.<id>.<slug>);
#      the desktop has the home + EVERY app ("AeroGyan <App>")
#   4. update: with only the old (round-3) 4 desktop shortcuts left, running the installer as an update
#      (/S --updated) brings back every missing desktop shortcut and duplicates nothing
#   5. the home shortcut opens the launcher page (every app a tile with its icon); clicking a tile opens that
#      app's window on /apps/<slug>/; an app's own shortcut opens a second app window (one program); starting
#      it again only focuses it
#   6. silent uninstall removes the program, every shortcut (home included), the folder and the Settings entry
# Writes selftest\pack\smoke.txt (+ the self-test's report.txt). Exit 1 when a check of steps 2–6 fails.
$ErrorActionPreference = 'Continue'
$out = Join-Path $PWD 'selftest\pack'
New-Item -ItemType Directory -Force $out | Out-Null
$r = New-Object System.Collections.Generic.List[string]
$script:fails = 0
function Pass($m) { $r.Add("PASS  $m") }
function Fail($m) { $r.Add("FAIL  $m"); $script:fails++ }
function Info($m) { $r.Add("info  $m") }
function WinName([string]$s) { (($s -replace '[^A-Za-z0-9 ]', '') -replace '\s+', ' ').Trim() }
function StartLabel($a) { $l = WinName ($a.name -replace '^AeroGyan\s+', ''); if ($l) { $l } else { $a.slug } }

$packId = $env:OFFICE_PACK
$data = Get-Content -Raw -Encoding UTF8 'office\apps.json' | ConvertFrom-Json
$pack = $data.packs | Where-Object { $_.id -eq $packId } | Select-Object -First 1
$apps = @($pack.apps | ForEach-Object { $s = $_; $data.apps | Where-Object { $_.slug -eq $s } | Select-Object -First 1 })
$name = $pack.name
$folderName = WinName $name
$exeName = (WinName $name) + '.exe'
$hubLnk = "$folderName.lnk"
$hubId = "tech.aerogyan.pack.$packId"
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
function As-Json($x) { if ($x) { $x | ConvertTo-Json -Compress -Depth 5 } else { 'none' } }

$wsh = New-Object -ComObject WScript.Shell
$shell = New-Object -ComObject Shell.Application
$smDir = Join-Path ([Environment]::GetFolderPath('Programs')) $folderName
$desk = [Environment]::GetFolderPath('Desktop')

# one shortcut: right program, arguments, icon file and AppUserModelID → '' or what is wrong
function Check-Link($dir, $file, $wantArgs, $icoName, $aumid, $exePath) {
  $lnk = Join-Path $dir $file
  if (-not (Test-Path -LiteralPath $lnk)) { return 'missing' }
  $sc = $wsh.CreateShortcut($lnk)
  $iconFile = ($sc.IconLocation -replace ',\s*-?\d+$', '')
  $id = ''
  try { $id = [string]$shell.Namespace($dir).ParseName($file).ExtendedProperty('System.AppUserModel.ID') } catch {}
  $p = @()
  if ($sc.TargetPath -ne $exePath) { $p += "target '$($sc.TargetPath)'" }
  if ($sc.Arguments -ne $wantArgs) { $p += "arguments '$($sc.Arguments)'" }
  if (-not (Test-Path -LiteralPath $iconFile) -or -not $iconFile.EndsWith("\$icoName")) { $p += "icon '$($sc.IconLocation)'" }
  if ($id -ne $aumid) { $p += "AppUserModelID '$id'" }
  return ($p -join '; ')
}
# every shortcut of the pack in Start and on the desktop
function Check-AllLinks($exePath, $tag) {
  $bad = 0
  $smLinks = @(Get-ChildItem -LiteralPath $smDir -Filter '*.lnk' -ErrorAction SilentlyContinue)
  if ($smLinks.Count -eq $apps.Count + 1) { Pass "$tag$($smLinks.Count) Start-menu shortcuts (home + $($apps.Count) apps)" } else { Fail "$tag Start-menu shortcuts — $($smLinks.Count) for home + $($apps.Count) apps: $(($smLinks | ForEach-Object { $_.Name }) -join ', ')"; $bad++ }
  $e = Check-Link $smDir $hubLnk '' '_pack.ico' $hubId $exePath
  if ($e) { Fail "${tag}Start › $folderName › $hubLnk (home) — $e"; $bad++ } else { Pass "${tag}Start › $folderName › $hubLnk (home, pack icon, AUMID $hubId)" }
  $e = Check-Link $desk $hubLnk '' '_pack.ico' $hubId $exePath
  if ($e) { Fail "${tag}desktop $hubLnk (home) — $e"; $bad++ } else { Pass "${tag}desktop $hubLnk (home)" }
  $ids = @{}
  foreach ($a in $apps) {
    $aumid = "tech.aerogyan.pack.$packId.$($a.slug)"
    $sl = (StartLabel $a) + '.lnk'
    $dl = (WinName $a.name) + '.lnk'
    $e1 = Check-Link $smDir $sl "--office=$($a.slug)" "$($a.slug).ico" $aumid $exePath
    $e2 = Check-Link $desk $dl "--office=$($a.slug)" "$($a.slug).ico" $aumid $exePath
    if ($e1 -or $e2) { Fail "${tag}$($a.slug): Start › $sl $(if ($e1) { "($e1)" } else { 'ok' }) · desktop $dl $(if ($e2) { "($e2)" } else { 'ok' })"; $bad++ }
    else { Pass "${tag}$($a.slug): Start › $sl + desktop $dl → --office=$($a.slug), $($a.slug).ico, $aumid" }
    $ids[$aumid] = 1
  }
  if ($ids.Count -eq $apps.Count) { Pass "${tag}every app has its own AppUserModelID" } else { Fail "${tag}own AppUserModelIDs"; $bad++ }
  $dupes = @(Get-ChildItem -LiteralPath $desk -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\(\d+\)\.lnk$' -or $_.Name -match ' - Copy' })
  if ($dupes.Count -eq 0) { Pass "${tag}no duplicate desktop shortcuts" } else { Fail "${tag}duplicate desktop shortcuts: $(($dupes | ForEach-Object { $_.Name }) -join ', ')"; $bad++ }
  $deskCount = @(Get-ChildItem -LiteralPath $desk -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'AeroGyan*' }).Count
  Info "${tag}desktop has $deskCount AeroGyan shortcuts (want $($apps.Count + 1))"
  if ($deskCount -ne $apps.Count + 1) { Fail "${tag}desktop shortcut count $deskCount, want $($apps.Count + 1)"; $bad++ }
  return $bad
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
    # a shared app (Sheets …) is live for every account
    $test = ($apps | Where-Object { $_.audience -eq 'both' } | Select-Object -First 1).slug
    if (-not $test) { $test = $apps[1].slug }
    $p = Start-Process -FilePath (Resolve-Path -LiteralPath $unpacked).Path -ArgumentList "--office=$test", "--aero-selftest=$out" -PassThru
    if (-not $p.WaitForExit(200000)) { Stop-Process -Id $p.Id -Force; Info 'self-test killed after 200 s' }
    Info "self-test of the unpacked app with --office=$test (see report below)"
    $icons = @(Get-ChildItem 'desktop-app\dist\win-unpacked\resources\office-icons' -Filter '*.ico' -ErrorAction SilentlyContinue)
    if ($icons.Count -eq $apps.Count + 1) { Pass "$($icons.Count) icons (.ico: home + apps) in resources\office-icons" } else { Fail "icons in resources\office-icons — $($icons.Count) for home + $($apps.Count) apps" }
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

  # ---- 3. shortcuts
  if (Test-Path -LiteralPath $smDir) { Pass "Start-menu folder '$folderName'" } else { Fail "Start-menu folder '$smDir'" }
  [void](Check-AllLinks $exe.FullName '')
  if (Test-Path 'HKCU:\Software\Classes\aerogyan') { Fail 'aerogyan:// links taken from the main app' } else { Pass 'aerogyan:// links left to the main app' }

  # ---- 4. an update brings back missing desktop shortcuts, duplicates nothing
  #      (like a round-3 install: only the first 4 apps had desktop shortcuts, no home)
  $reg = "HKCU:\Software\tech.aerogyan.pack.$packId"
  $removed = 0
  Remove-Item -LiteralPath (Join-Path $desk $hubLnk) -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $reg -Name 'desktop_hub' -ErrorAction SilentlyContinue
  for ($k = 4; $k -lt $apps.Count; $k++) {
    $dl = Join-Path $desk ((WinName $apps[$k].name) + '.lnk')
    if (Test-Path -LiteralPath $dl) { Remove-Item -LiteralPath $dl -Force; $removed++ }
    Remove-ItemProperty -Path $reg -Name "desktop_$($apps[$k].slug)" -ErrorAction SilentlyContinue
  }
  Info "update test: removed the home + $removed app desktop shortcuts (as in the old 4-shortcut pack), now running the installer as an update"
  $p3 = Start-Process -FilePath $setup.FullName -ArgumentList '/S', '--updated' -PassThru
  if ($p3.WaitForExit(240000)) { Pass "update install (/S --updated) — exit $($p3.ExitCode)" } else { Fail 'update install finished in time' }
  Start-Sleep -Seconds 3
  Stop-Pack
  $exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter $exeName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { Fail 'program still installed after the update'; throw 'gone after update' }
  [void](Check-AllLinks $exe.FullName 'after update: ')

  # ---- 5. the home page, a tile, an app shortcut
  $ud = Join-Path $env:APPDATA $name
  New-Item -ItemType Directory -Force $ud | Out-Null
  Set-Content (Join-Path $ud 'ci-report.on') '1'
  $rep = Join-Path $ud 'ci-report.json'
  Remove-Item -LiteralPath $rep -ErrorAction SilentlyContinue
  $a1 = $apps[0]; $a2 = $apps[$apps.Count - 1]
  $url1 = "https://aerogyan.tech/apps/$($a1.slug)/"; $url2 = "https://aerogyan.tech/apps/$($a2.slug)/"
  Start-Process -FilePath (Join-Path $desk $hubLnk)
  $h = Wait-Report $rep { param($x) $x.home -and $x.home.loaded -and @($x.homeTiles).Count -gt 0 } 60
  if ($h -and $h.home -and $h.home.url -like '*/pack-home.html' -and $h.home.visible) { Pass "home shortcut opens the launcher page '$($h.home.title)' ($($h.home.url -replace '^.*/resources/', 'resources/'))" }
  else { Fail "home shortcut opens the launcher page — $(As-Json $h)" }
  $tiles = @($h.homeTiles)
  $withIcon = @($tiles | Where-Object { $_ -like '*|icon|*' })
  if ($tiles.Count -eq $apps.Count -and $withIcon.Count -eq $apps.Count) { Pass "launcher page: $($tiles.Count) tiles, all with their icon ($((($tiles | ForEach-Object { ($_ -split '\|')[2] }) -join ', ')))" }
  else { Fail "launcher page tiles — $($tiles.Count) tiles, $($withIcon.Count) with an icon, for $($apps.Count) apps: $($tiles -join ', ')" }
  if (@($h.windows).Count -eq 0) { Pass 'no app window opens by itself with the home' } else { Fail "home opened app windows: $(As-Json $h.windows)" }
  Set-Content -NoNewline -LiteralPath (Join-Path $ud 'ci-click') $a2.slug
  $c = Wait-Report $rep { param($x) @($x.windows | Where-Object { $_.slug -eq $a2.slug -and $_.url -like "$url2*" }).Count -eq 1 } 60
  $cw = @($c.windows | Where-Object { $_.slug -eq $a2.slug -and $_.url -like "$url2*" })
  if ($cw.Count -eq 1 -and $c.home) { Pass "clicking the '$($a2.name)' tile opens its window on $($cw[0].url) (home stays open)" }
  else { Fail "clicking the '$($a2.name)' tile — $(As-Json $c)" }
  if ($c -and $c.ua -like "*(Desktop; Windows; Office pack $packId)*") { Pass "user-agent '… (Desktop; Windows; Office pack $packId)'" } else { Fail "user-agent names the pack — $($c.ua)" }
  Start-Sleep -Seconds 2
  $l1 = Join-Path $smDir ((StartLabel $a1) + '.lnk')
  Start-Process -FilePath $l1
  $s2 = Wait-Report $rep { param($x) @($x.windows | Where-Object { $_.slug -eq $a1.slug -and $_.url -like "$url1*" }).Count -eq 1 } 60
  $w1 = @($s2.windows | Where-Object { $_.slug -eq $a1.slug -and $_.url -like "$url1*" })
  $w2 = @($s2.windows | Where-Object { $_.slug -eq $a2.slug -and $_.url -like "$url2*" })
  if (@($s2.windows).Count -eq 2 -and $w1.Count -eq 1 -and $w2.Count -eq 1) { Pass "Start › $folderName › $(StartLabel $a1) opens a second app window on $($w1[0].url)" }
  else { Fail "two app windows on $url1 and $url2 — $(As-Json $s2)" }
  if ($w1.Count -eq 1 -and $w2.Count -eq 1 -and $w1[0].appId -ne $w2[0].appId -and $w1[0].appId -ne $hubId) { Pass "own taskbar ids: $hubId (home) · $($w1[0].appId) · $($w2[0].appId)" } else { Fail 'each window has its own taskbar id' }
  $procs = Main-Processes
  if ($procs.Count -eq 1) { Pass "one program runs the home and both app windows (pid $($procs[0].ProcessId))" } else { Fail "one program — $($procs.Count) main processes" }
  Start-Process -FilePath $l1
  Start-Sleep -Seconds 4
  $s3 = Read-Report $rep
  if ($s3 -and @($s3.windows).Count -eq 2 -and (Main-Processes).Count -eq 1) { Pass "starting '$($a1.name)' again focuses its window (still 2 app windows)" } else { Fail "starting '$($a1.name)' again — $(As-Json $s3)" }
  Start-Process -FilePath (Join-Path $desk $hubLnk)
  Start-Sleep -Seconds 3
  $s4 = Read-Report $rep
  if ($s4 -and $s4.home -and @($s4.windows).Count -eq 2 -and (Main-Processes).Count -eq 1) { Pass 'starting the home again focuses it (no second home)' } else { Fail "starting the home again — $(As-Json $s4)" }
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

  # ---- 6. uninstall
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
  if (-not (Test-Path -LiteralPath $exe.FullName)) { Pass 'uninstall: program removed' } else { Fail "uninstall: $($exe.FullName) still there" }
  if (-not (Test-Path -LiteralPath $smDir)) { Pass "uninstall: Start-menu folder '$folderName' removed" } else { Fail "uninstall: Start-menu folder still has $((Get-ChildItem -LiteralPath $smDir | ForEach-Object { $_.Name }) -join ', ')" }
  $left = @(@($hubLnk) + @($apps | ForEach-Object { (WinName $_.name) + '.lnk' }) | Where-Object { Test-Path -LiteralPath (Join-Path $desk $_) })
  if ($left.Count -eq 0) { Pass "uninstall: all $($apps.Count + 1) desktop shortcuts removed (home included)" } else { Fail "uninstall: desktop shortcuts left — $($left -join ', ')" }
  if (-not (Test-Path $reg)) { Pass 'uninstall: no registry left-overs' } else { Fail "uninstall: $reg left" }
} catch { Fail "smoke test ran — $($_.Exception.Message)" }

$r | Set-Content "$out\smoke.txt"
"=== $name ($packId) ==="
Get-Content "$out\smoke.txt"
if (Test-Path "$out\report.txt") { '--- self-test (unpacked app) ---'; Get-Content "$out\report.txt" }
if ($script:fails -gt 0) { "$($script:fails) check(s) failed"; exit 1 }
exit 0
