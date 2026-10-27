# Firefox-Zen installer. Run in PowerShell (no admin needed, it asks when it has to):
#   irm https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.ps1 | iex
# Running it again updates an existing install.
# $env:FIREFOX_ZEN_PROFILE = '<profile folder>' skips the profile picker.

& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $repo = 'https://github.com/ishid4/Firefox-Zen'
  $ffData = Join-Path $env:APPDATA 'Mozilla\Firefox'

  function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

  # Firefox install folder
  $exe = $null
  foreach ($root in 'HKLM:', 'HKCU:') {
    $key = "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"
    if (Test-Path $key) { $exe = (Get-ItemProperty $key).'(default)'; break }
  }
  if (-not $exe) { $exe = 'C:\Program Files\Mozilla Firefox\firefox.exe' }
  $ffDir = Split-Path ($exe.Trim('"'))
  if (-not (Test-Path (Join-Path $ffDir 'firefox.exe'))) {
    Say "Firefox not found (looked in $ffDir)." Red
    return
  }

  # Profile
  if ($env:FIREFOX_ZEN_PROFILE) {
    $profileDir = $env:FIREFOX_ZEN_PROFILE
  } else {
    $profiles = @(Get-ChildItem (Join-Path $ffData 'Profiles') -Directory -ErrorAction SilentlyContinue |
      Where-Object { (Test-Path (Join-Path $_.FullName 'prefs.js')) -and $_.Name -notmatch '_backup$' })
    if (-not $profiles) {
      Say 'No Firefox profile found. Start Firefox once, close it, then run this again.' Red
      return
    }
    # Firefox's default profile (profiles.ini: Install section, else Default=1)
    $default = $null
    $ini = Join-Path $ffData 'profiles.ini'
    if (Test-Path $ini) {
      $text = Get-Content $ini -Raw
      if ($text -match '(?ms)^\[Install[^\]]*\][^\[]*?^Default=(.+?)\s*$') { $default = $Matches[1] }
      elseif ($text -match '(?ms)^Path=(.+?)\s*$[^\[]*?^Default=1') { $default = $Matches[1] }
    }
    $pick = 0
    for ($i = 0; $i -lt $profiles.Count; $i++) {
      if ($default -and $default.Replace('/', '\').EndsWith($profiles[$i].Name)) { $pick = $i }
    }
    if ($profiles.Count -gt 1) {
      Say 'Firefox profiles:'
      for ($i = 0; $i -lt $profiles.Count; $i++) {
        $mark = if ($i -eq $pick) { '  (default)' } else { '' }
        Say ("  [{0}] {1}{2}" -f ($i + 1), $profiles[$i].Name, $mark)
      }
      $answer = Read-Host "Install into which profile? [$($pick + 1)]"
      if ($answer) {
        $n = 0
        if (-not [int]::TryParse($answer, [ref]$n) -or $n -lt 1 -or $n -gt $profiles.Count) {
          Say 'Not a profile number.' Red
          return
        }
        $pick = $n - 1
      }
    }
    $profileDir = $profiles[$pick].FullName
  }
  if (-not (Test-Path $profileDir)) { Say "Profile folder not found: $profileDir" Red; return }
  $chrome = Join-Path $profileDir 'chrome'
  Say "Profile: $profileDir"

  # Firefox must be closed (the startup cache is cleared below)
  while (Get-Process firefox -ErrorAction SilentlyContinue) {
    Read-Host 'Close Firefox, then press Enter' | Out-Null
  }

  # Theme files into <profile>\chrome
  $installed = Test-Path (Join-Path $chrome 'JS\firefox-zen-settings.uc.js')
  if ((Test-Path $chrome) -and -not $installed) {
    $backup = "$chrome.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $chrome $backup
    Say "Moved your old chrome folder to $backup" Yellow
  }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($installed -and (Test-Path (Join-Path $chrome '.git'))) {
    Say 'Updating with git...'
    git -C $chrome pull --ff-only
    if ($LASTEXITCODE) { Say 'git pull failed (local changes?). Fix it in the chrome folder and run this again.' Red; return }
  } elseif (-not $installed -and $git) {
    Say 'Downloading with git...'
    git clone --depth 1 "$repo.git" $chrome
    if ($LASTEXITCODE) { Say 'git clone failed.' Red; return }
  } else {
    Say 'Downloading...'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "firefox-zen-$([guid]::NewGuid())"
    New-Item -ItemType Directory $tmp | Out-Null
    try {
      $zip = Join-Path $tmp 'main.zip'
      Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
      Expand-Archive $zip $tmp
      New-Item -ItemType Directory $chrome -Force | Out-Null
      Copy-Item (Join-Path $tmp 'Firefox-Zen-main\*') $chrome -Recurse -Force
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # Loader files into the Firefox install folder (needs admin, only when they changed)
  $copies = @(
    @{ From = Join-Path $chrome 'program\config.js'; To = Join-Path $ffDir 'config.js' },
    @{ From = Join-Path $chrome 'program\defaults\pref\config-prefs.js'; To = Join-Path $ffDir 'defaults\pref\config-prefs.js' }
  ) | Where-Object {
    # Compare text, not bytes: git may have checked the files out with CRLF
    -not (Test-Path $_.To) -or
      ((Get-Content $_.From -Raw) -replace "`r`n", "`n") -ne ((Get-Content $_.To -Raw) -replace "`r`n", "`n")
  }
  if ($copies) {
    Say 'Copying the loader into the Firefox folder (Windows will ask for admin)...'
    $cmd = ($copies | ForEach-Object {
      "New-Item -ItemType Directory -Force '$(Split-Path $_.To)' | Out-Null; Copy-Item -Force '$($_.From)' '$($_.To)'"
    }) -join '; '
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    try {
      $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $encoded
    } catch {
      Say 'Admin permission was declined. Run this again, or copy the program folder by hand (see README).' Red
      return
    }
    if ($p.ExitCode) { Say 'Copying the loader failed.' Red; return }
  }

  # Clear the startup cache so Firefox loads the new scripts
  $local = Join-Path $env:LOCALAPPDATA ('Mozilla\Firefox\Profiles\' + (Split-Path $profileDir -Leaf))
  Remove-Item (Join-Path $local 'startupCache') -Recurse -Force -ErrorAction SilentlyContinue

  Say ''
  Say 'Firefox-Zen is installed.' Green
  Say 'Start Firefox and click "Restart now" when Firefox-Zen asks (first start only).'
}
