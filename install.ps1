# Firefox-Zen installer. Run in PowerShell (no admin needed, it asks when it has to):
#   irm https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.ps1 | iex
# Running it again updates an existing install.
# $env:FIREFOX_ZEN_PROFILE = '<profile folder>' skips the profile picker.

# "Run with PowerShell" (and shortcuts, Win+R) start a window just for this
# script, which closes as soon as it ends: then wait for Enter at the end, so
# the result stays readable. Pasted into an open PowerShell, nothing changes.
$fzOwnWindow = & {
  if ($Host.Name -ne 'ConsoleHost') { return $false }
  # PowerShell takes any prefix of a parameter name (-c, -Comm, -f...)
  $flags = @([Environment]::GetCommandLineArgs() | Select-Object -Skip 1 |
    Where-Object { $_ -match '^[-/]\w' } | ForEach-Object { $_.Substring(1).ToLower() })
  $any = { param($names) [bool]($flags | Where-Object { $f = $_; $names | Where-Object { $_.StartsWith($f) } }) }
  # -Command/-File/-EncodedCommand run a script and exit, unless -NoExit;
  # -NonInteractive can't read Enter.
  (& $any 'command', 'file', 'encodedcommand') -and -not (& $any 'noexit', 'noninteractive')
}

try { & {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $repo = 'https://github.com/ishid4/Firefox-Zen'
  $ffData = Join-Path $env:APPDATA 'Mozilla\Firefox'

  function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

  # Profile folder name -> the name Firefox shows for it. Firefox's profile
  # manager keeps names in "Profile Groups\<StoreID>.sqlite" (read with the
  # SQLite that ships with Windows); older profiles only have Name= in
  # profiles.ini. Best effort: anything missing just shows the folder name.
  function Get-ProfileNames($ini) {
    $names = @{}
    if (-not $ini) { return $names }
    foreach ($m in [regex]::Matches($ini, '(?ms)^\[Profile\d+\]\s*$(.*?)(?=^\[|\z)')) {
      $body = $m.Groups[1].Value
      if ($body -match '(?m)^Name=(.+?)\s*$') {
        $name = $Matches[1]
        if ($body -match '(?m)^Path=(.+?)\s*$') { $names[(Split-Path $Matches[1].Replace('/', '\') -Leaf)] = $name }
      }
    }
    try {
      if (-not ('FirefoxZen.Sqlite' -as [type])) {
        Add-Type -Namespace FirefoxZen -Name Sqlite -MemberDefinition @'
[DllImport("winsqlite3.dll")] public static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
[DllImport("winsqlite3.dll")] public static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr stmt, IntPtr tail);
[DllImport("winsqlite3.dll")] public static extern int sqlite3_step(IntPtr stmt);
[DllImport("winsqlite3.dll")] public static extern IntPtr sqlite3_column_text(IntPtr stmt, int col);
[DllImport("winsqlite3.dll")] public static extern int sqlite3_column_bytes(IntPtr stmt, int col);
[DllImport("winsqlite3.dll")] public static extern int sqlite3_finalize(IntPtr stmt);
[DllImport("winsqlite3.dll")] public static extern int sqlite3_close(IntPtr db);
'@
      }
      $utf8 = [Text.Encoding]::UTF8
      $column = {
        param($stmt, $col)
        $n = [FirefoxZen.Sqlite]::sqlite3_column_bytes($stmt, $col)
        if ($n -le 0) { return '' }
        $bytes = New-Object byte[] $n
        [Runtime.InteropServices.Marshal]::Copy([FirefoxZen.Sqlite]::sqlite3_column_text($stmt, $col), $bytes, 0, $n)
        $utf8.GetString($bytes)
      }
      $ids = [regex]::Matches($ini, '(?m)^StoreID=(\S+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
      foreach ($id in $ids) {
        $file = Join-Path $ffData "Profile Groups\$id.sqlite"
        if (-not (Test-Path $file)) { continue }
        $db = [IntPtr]::Zero
        # 1 = SQLITE_OPEN_READONLY
        if ([FirefoxZen.Sqlite]::sqlite3_open_v2($utf8.GetBytes("$file`0"), [ref]$db, 1, [IntPtr]::Zero) -eq 0) {
          $stmt = [IntPtr]::Zero
          if ([FirefoxZen.Sqlite]::sqlite3_prepare_v2($db, $utf8.GetBytes("SELECT path, name FROM Profiles`0"), -1, [ref]$stmt, [IntPtr]::Zero) -eq 0) {
            # 100 = SQLITE_ROW
            while ([FirefoxZen.Sqlite]::sqlite3_step($stmt) -eq 100) {
              $path = & $column $stmt 0
              $name = & $column $stmt 1
              if ($path -and $name) { $names[(Split-Path $path.Replace('/', '\') -Leaf)] = $name }
            }
            [void][FirefoxZen.Sqlite]::sqlite3_finalize($stmt)
          }
        }
        [void][FirefoxZen.Sqlite]::sqlite3_close($db)
      }
    } catch {}
    $names
  }

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
      $names = Get-ProfileNames $text
      Say 'Firefox profiles:'
      for ($i = 0; $i -lt $profiles.Count; $i++) {
        $mark = if ($i -eq $pick) { '  (default)' } else { '' }
        $label = $profiles[$i].Name
        $name = $names[$label]
        if ($name -and $name -ne $label) { $label = "$name ($label)" }
        Say ("  [{0}] {1}{2}" -f ($i + 1), $label, $mark)
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

  # A profile that ran another userChromeJS setup may have the loader switched
  # off, which hides every script. Drop the pref: the loader turns it back on.
  $prefs = Join-Path $profileDir 'prefs.js'
  if (Test-Path $prefs) {
    $text = [IO.File]::ReadAllText($prefs)
    $fixed = $text -replace '(?m)^user_pref\("userChromeJS\.enabled",\s*false\);\r?\n?', ''
    if ($fixed -ne $text) {
      [IO.File]::WriteAllText($prefs, $fixed, (New-Object Text.UTF8Encoding $false))
      Say 'Turned the script loader back on (userChromeJS.enabled was off).' Yellow
    }
  }

  # Clear the startup cache so Firefox loads the new scripts
  $local = Join-Path $env:LOCALAPPDATA ('Mozilla\Firefox\Profiles\' + (Split-Path $profileDir -Leaf))
  Remove-Item (Join-Path $local 'startupCache') -Recurse -Force -ErrorAction SilentlyContinue

  Say ''
  Say 'Firefox-Zen is installed.' Green
  Say 'Start Firefox and click "Restart now" when Firefox-Zen asks (first start only).'
} } catch {
  Write-Host "Install failed: $_" -ForegroundColor Red
} finally {
  if ($fzOwnWindow) {
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
  }
}
