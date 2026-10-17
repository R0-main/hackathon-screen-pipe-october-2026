# NOS Brainer: connects this Windows computer to the company brain in one command.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url https://brain.example.com --token cb_...
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url https://brain.example.com --join cj_... --name ...
#   ... --ca %USERPROFILE%\.company-brain\ca.crt   (self-hosted brain on local HTTPS: certificate of its authority, already
#                                              checked by its fingerprint in the prompt; added to the user's store)
#
# Windows equivalent of install.sh (same options, same exit codes); install.sh hands over to it in Git Bash.
# Pure ASCII file: Windows PowerShell 5.1 reads a .ps1 without a BOM in the ANSI code page. The detailed messages
# come from the brain client.
# 1. Node.js: the private copy %USERPROFILE%\.company-brain\node if it is at the version pinned below; otherwise a
#    permanently installed Node.js >= 20 x64; otherwise installs the private copy (official zip, SHA-256 fingerprint checked).
# 2. Downloads the brain client (<url>/brain.mjs), checks that it really is JavaScript, then writes the shortcuts
#    brain.cmd (PowerShell, cmd, Git Bash) and brain (Git Bash).
# 3. Runs `brain setup` with the same options and returns its exit code. With --join (team message), runs
#    `brain join`: the request waits for an admin to accept it, then moves on to setup.
#
# Exit codes (the same as install.sh):
#   0, 1, 3, 6, 7, 8  those of `brain setup` or `brain join`, passed through: 0 = everything is connected; 1 = failure
#                 (run `brain.cmd doctor`); 3 = permission pending; 6 = connected, but without Screenpipe;
#                 7 = request not accepted yet (run `brain.cmd join` again); 8 = request rejected.
#   2             bad call: --url missing or not http(s).
#   4             unsupported system, or Node.js cannot be installed or run here (the message says what to install).
#   5             download impossible (network, proxy, wrong address, error page instead of the client):
#                 run the same command again. The client and Node.js already installed stay intact.
#   9             (prompt command only) unexpected brain certificate: fingerprint different from the prompt's.
# The token is never displayed.
# Tests only: COMPANY_BRAIN_FORCE_PRIVATE_NODE=1 ignores the system's Node.js (CI tests the download).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PowerShell 7.3+: a non-zero exit code from a program must not become an exception.
$PSNativeCommandUseErrorActionPreference = $false

$NodeVersion = '22.23.3'
# Always the x64 version, even on Windows ARM64: Screenpipe is only published for win32-x64, and Windows 11 on ARM
# emulates x64. Official fingerprint (https://nodejs.org/dist/v22.23.3/SHASUMS256.txt), pinned here with the version.
$NodeDist = "node-v$NodeVersion-win-x64"
$NodeZipSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
$OnWindows = [IO.Path]::DirectorySeparatorChar -eq '\'
$RawArgs = @($args)

function Say([string]$Message) { [Console]::Out.WriteLine($Message) }
function Warn([string]$Message) { [Console]::Error.WriteLine($Message) }
function Fail([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

# powershell -File splits a "-name:value" argument in two (PowerShell 7 even loses the colon): "--url=https://x"
# arrives as "--url=https" then "//x". We glue them back, to read --url= and to pass setup exactly what was typed.
function Repair-Arguments([object[]]$Items) {
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Items.Count; $i++) {
    $a = [string]$Items[$i]
    if ($a -like '-*=*' -and $i + 1 -lt $Items.Count -and ([string]$Items[$i + 1]) -like '//*') {
      if (-not $a.EndsWith(':')) { $a += ':' }
      $a += [string]$Items[$i + 1]
      $i++
    }
    $out.Add($a)
  }
  return $out.ToArray()
}

# Runs a program and returns its exit code and output, without Windows PowerShell 5.1 turning its error
# output into an exception.
function Invoke-Tool([string]$Exe, [string[]]$Arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = -1
    $out = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
    return @{ Code = $global:LASTEXITCODE; Out = $out }
  } catch {
    return @{ Code = -1; Out = @("$($_.Exception.Message)") }
  } finally {
    $ErrorActionPreference = $saved
  }
}

# Probes a node: version, architecture and real path (process.execPath). Written to a file and read back as UTF-8:
# a path with accents arrives intact whatever the console's code page. Returns $null if it does not start.
function Get-NodeInfo([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $null }
  $file = Join-Path $BrainHome "node-info.$PID.txt"
  try {
    $r = Invoke-Tool $Exe @('-e', "require('fs').writeFileSync(process.argv[1],[process.versions.node,process.arch,process.execPath].join('*'))", $file)
    if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $file)) { return $null }
    $parts = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8).Split([char]'*')
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  if ($parts.Count -ne 3) { return $null }
  $major = 0
  [void][int]::TryParse($parts[0].Split('.')[0], [ref]$major)
  return [pscustomobject]@{ Version = $parts[0]; Major = $major; Arch = $parts[1]; Path = $parts[2] }
}

# Hooks, MCP and scheduled sync record Node.js's real path: that of a version manager disappears
# on the next update, and everything would break silently. The private copy is used instead.
function Test-VersionedPath([string]$Path) {
  $p = $Path.Replace('/', '\').ToLowerInvariant()
  foreach ($m in @('\nvm\', '\fnm\', '\fnm_multishells\', '\volta\', '\.volta\', '\scoop\', '\mise\')) {
    if ($p.Contains($m)) { return $true }
  }
  return $false
}

# Download: 3 attempts, except on a definitive error (4xx: wrong address). Returns $false, reason in $script:DownloadError.
function Save-Url([string]$Url, [string]$OutFile) {
  for ($try = 1; $try -le 3; $try++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec 900
      return $true
    } catch {
      $err = $_
      $script:DownloadError = $err.Exception.Message
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      $status = 0
      try { $status = [int]$err.Exception.Response.StatusCode } catch { }
      if ($status -ge 400 -and $status -lt 500 -and $status -ne 408 -and $status -ne 429) { return $false }
      if ($try -lt 3) { Start-Sleep -Seconds 2 }
    }
  }
  return $false
}

# SHA-256 fingerprint through .NET, not Get-FileHash: that function comes from a module Windows PowerShell 5.1 does not
# load when started from PowerShell 7 (PSModulePath then points to PowerShell 7's modules), which is the case
# of Claude Code's PowerShell tool, which runs `powershell`.
function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
}

# Moves a folder, retrying: the antivirus sometimes holds a freshly extracted file for a few moments.
function Move-Directory([string]$From, [string]$To) {
  for ($try = 1; $try -le 5; $try++) {
    try {
      Move-Item -LiteralPath $From -Destination $To
      return $true
    } catch {
      if ($try -lt 5) { Start-Sleep -Seconds 1 }
    }
  }
  return $false
}

# Installs the private copy of Node.js. Returns $null if it is in place, otherwise @{ Code; Message }: nothing was replaced.
function Install-PrivateNode {
  if (-not $OnWindows) {
    return @{ Code = 4; Message = 'install.ps1 only installs Node.js for Windows: elsewhere, use install.sh.' }
  }
  $zipUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeDist.zip"
  $work = Join-Path $BrainHome "node.download.$PID"
  $zip = Join-Path $work "$NodeDist.zip"
  $out = Join-Path $work 'x'
  try {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    [void][IO.Directory]::CreateDirectory($out)
    Say "Installing Node.js v$NodeVersion in $PrivateDir (private copy, no admin rights)..."
    if (-not (Save-Url $zipUrl $zip)) {
      return @{ Code = 5; Message = "Download failed: $zipUrl ($script:DownloadError). Run the same command again." }
    }
    if ((Get-Sha256 $zip) -ne $NodeZipSha256) {
      return @{ Code = 5; Message = 'The Node.js download does not match its official fingerprint (cut off, or modified by a proxy?): run the same command again.' }
    }
    # Windows tar.exe (bsdtar) reads zips and is fast; never Git's tar, which does not read them. Otherwise .NET.
    $extracted = $false
    $tar = "$env:SystemRoot\System32\tar.exe"
    if (Test-Path -LiteralPath $tar) { $extracted = (Invoke-Tool $tar @('-xf', $zip, '-C', $out)).Code -eq 0 }
    if (-not $extracted) {
      try {
        Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $out)
        $extracted = $true
      } catch { }
    }
    if (-not $extracted) {
      try {
        Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -LiteralPath $zip -DestinationPath $out -Force
        $extracted = $true
      } catch { }
    }
    $newDir = Join-Path $out $NodeDist
    if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $newDir 'node.exe'))) {
      return @{ Code = 4; Message = "Cannot extract Node.js: check the disk space, then run the same command again." }
    }
    # Trial before replacing anything: a copy that does not start here does not take the place of the old one.
    $info = Get-NodeInfo (Join-Path $newDir 'node.exe')
    if (-not $info -or $info.Version -ne $NodeVersion) {
      $why = (Invoke-Tool (Join-Path $newDir 'node.exe') @('-v')).Out | Select-Object -First 1
      return @{ Code = 4; Message = "Node.js v$NodeVersion does not start on this computer ($why): Windows 10 or 11 x64 (or Windows 11 ARM) required. Install Node.js 20 or later (https://nodejs.org), then run the same command again." }
    }
    # Swap without ever losing Node.js: the old copy is set aside, the new one takes its place, then
    # the old one is deleted. A copy in use (MCP, sync) cannot be moved: it is kept.
    $old = Join-Path $BrainHome "node.old.$PID"
    if (Test-Path -LiteralPath $PrivateDir) {
      if (-not (Move-Directory $PrivateDir $old)) {
        return @{ Code = 4; Message = "Cannot replace $PrivateDir (Node.js in use?): run the same command again later." }
      }
    }
    if (-not (Move-Directory $newDir $PrivateDir)) {
      if (Test-Path -LiteralPath $old) { [void](Move-Directory $old $PrivateDir) }
      return @{ Code = 4; Message = "Cannot install Node.js in ${PrivateDir}: check the disk space, then run the same command again." }
    }
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    return $null
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# cmd reads a .cmd in the system's OEM code page (850 in France): that is the one a path with accents needs.
function Get-OemEncoding {
  $cp = 0
  try { $cp = [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name OEMCP).OEMCP } catch { }
  if ($cp -le 0) { $cp = [Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage }
  try { return [Text.Encoding]::GetEncoding($cp) } catch { }
  try {
    [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
    return [Text.Encoding]::GetEncoding($cp)
  } catch { }
  return [Text.Encoding]::ASCII
}

# Written alongside then replaced in one go: a shortcut is never half written.
function Write-FileAtomic([string]$Path, [byte[]]$Bytes) {
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllBytes($tmp, $Bytes)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# C:\Users\x -> /c/Users/x (Git Bash); \\server\share -> //server/share.
function ConvertTo-PosixPath([string]$Path) {
  if ($Path -match '^([A-Za-z]):[\\/](.*)$') { return '/' + $Matches[1].ToLowerInvariant() + '/' + ($Matches[2] -replace '\\', '/') }
  return ($Path -replace '\\', '/')
}

# Between single quotes for sh: spaces, $, ` or " in a path are never interpreted.
function ConvertTo-ShQuoted([string]$Value) { return "'" + $Value.Replace("'", "'\''") + "'" }

# --- Call ---------------------------------------------------------------------------------------------------------

$ScriptArgs = @(Repair-Arguments $RawArgs)
$Url = ''
$Ca = ''
$Command = 'setup'
for ($i = 0; $i -lt $ScriptArgs.Count; $i++) {
  if ($ScriptArgs[$i] -eq '--url' -and $i + 1 -lt $ScriptArgs.Count) { $Url = $ScriptArgs[$i + 1] }
  elseif ($ScriptArgs[$i] -like '--url=*') { $Url = $ScriptArgs[$i].Substring(6) }
  if ($ScriptArgs[$i] -eq '--ca' -and $i + 1 -lt $ScriptArgs.Count) { $Ca = $ScriptArgs[$i + 1] }
  elseif ($ScriptArgs[$i] -like '--ca=*') { $Ca = $ScriptArgs[$i].Substring(5) }
  # Team message: asks to join (brain join), which moves on to setup once accepted.
  if ($ScriptArgs[$i] -eq '--join' -or $ScriptArgs[$i] -like '--join=*') { $Command = 'join' }
}
if (-not $Url) { Fail 2 'Usage: install.ps1 --url <brain address> --token <personal token>  (or --join <team code>)' }
$Url = $Url.TrimEnd('/')
# The client downloaded here runs on the computer and receives the token: HTTPS required, except on this very computer.
# The received value is not echoed back: it could be the token passed in the wrong place.
if ($Url -cmatch '^https://.') { }
elseif ($Url -cmatch '^http://(localhost|127\.0\.0\.1|\[::1\])([:/].*)?$') { }
elseif ($Url -cmatch '^http://.') { Warn "Warning: $Url is not HTTPS, the client and your token will travel in clear text over the network." }
else { Fail 2 "--url must be the brain's address, with https:// (for example --url https://brain.example.com)." }

# Self-hosted brain on local HTTPS (--ca): the certificate of its authority, already checked by its fingerprint in the
# prompt. Added to the Windows user's trusted certificates (browsers, and the downloads below);
# the client receives the option as is and trusts it on its side.
if ($Ca) {
  if (-not (Test-Path -LiteralPath $Ca -PathType Leaf)) { Fail 2 "Certificate not found: $Ca (--ca option)." }
  if ($OnWindows) {
    try {
      $caCert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $Ca
      $present = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction Stop | Where-Object { $_.Thumbprint -eq $caCert.Thumbprint }
      if (-not $present) {
        Say "Brain certificate added to the user's trusted certificates (Windows asks for confirmation)."
        & certutil -user -addstore Root $Ca | Out-Null
      }
    } catch {
      Warn "Brain certificate not added to the Windows store ($($_.Exception.Message)): do it by hand: certutil -user -addstore Root `"$Ca`""
    }
  }
}

# Windows PowerShell 5.1: TLS 1.2 (not always on by default) and corporate proxy with the Windows account.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }

# Client folder: the Windows user's (%USERPROFILE%, the one Node.js reads).
$CustomHome = [bool]$env:COMPANY_BRAIN_HOME
if ($CustomHome) {
  $BrainHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:COMPANY_BRAIN_HOME)
  $env:COMPANY_BRAIN_HOME = $BrainHome
} elseif ($env:USERPROFILE) {
  $BrainHome = Join-Path $env:USERPROFILE '.company-brain'
} else {
  Fail 4 "USERPROFILE is not set: cannot find the Windows user's folder."
}
try { [void][IO.Directory]::CreateDirectory($BrainHome) }
catch { Fail 4 "Cannot create $BrainHome ($($_.Exception.Message)): check its permissions, then run the same command again." }
$PrivateDir = Join-Path $BrainHome 'node'
$PrivateNode = Join-Path $PrivateDir 'node.exe'
$NewMjs = Join-Path $BrainHome "brain.new.$PID.mjs"
$Mjs = Join-Path $BrainHome 'brain.mjs'

try {
  # Brain client, downloaded first (a wrong address fails right away), checked once Node.js is found.
  # The temporary name must end in .mjs: otherwise node --check reads it as CommonJS and refuses the real client.
  Say "Downloading the brain client: $Url/brain.mjs"
  if (-not (Save-Url "$Url/brain.mjs" $NewMjs)) {
    Fail 5 "Download failed: $Url/brain.mjs ($script:DownloadError). Check the network, the proxy or the brain address, then run the same command again."
  }

  # 1. The private copy, if it is at the pinned version.
  $Node = $null
  $NodeVer = $null
  $Private = Get-NodeInfo $PrivateNode
  if ($Private -and $Private.Major -ge 20) {
    if ($Private.Version -eq $NodeVersion) { $Node = $PrivateNode; $NodeVer = $Private.Version }
  } else {
    $Private = $null
  }
  # 2. Otherwise a system Node.js >= 20 x64, permanently installed: its real path is recorded, not the shim's.
  $Fallback = $null
  if (-not $Node -and $env:COMPANY_BRAIN_FORCE_PRIVATE_NODE -ne '1') {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $sys = $null
    if ($cmd) { $sys = Get-NodeInfo $cmd.Path }
    if ($sys) {
      if ($sys.Major -lt 20) { Say "Node.js v$($sys.Version) ($($sys.Path)) is too old: version 20 or later is required." }
      elseif ($OnWindows -and $sys.Arch -ne 'x64') { Say "Node.js $($sys.Path) is $($sys.Arch): Screenpipe only exists as x64 on Windows." }
      elseif (Test-VersionedPath $sys.Path) {
        Say "Node.js $($sys.Path) comes from a version manager: it may disappear on its next update."
        $Fallback = $sys
      } else {
        $Node = $sys.Path
        $NodeVer = $sys.Version
      }
    }
  }
  # 3. Otherwise the private copy, downloaded and checked. If it cannot be installed, keep what already works.
  if (-not $Node) {
    $problem = Install-PrivateNode
    if (-not ($problem -is [hashtable])) {
      $Node = $PrivateNode
      $NodeVer = $NodeVersion
    } elseif ($Private) {
      Warn $problem.Message
      Warn "Continuing with the private copy already installed (Node.js v$($Private.Version))."
      $Node = $PrivateNode
      $NodeVer = $Private.Version
    } elseif ($Fallback) {
      Warn $problem.Message
      Warn "Continuing with $($Fallback.Path): if a Node.js update removes it, run the same command again."
      $Node = $Fallback.Path
      $NodeVer = $Fallback.Version
    } else {
      Fail $problem.Code $problem.Message
    }
  }

  # The downloaded client must be valid JavaScript: an HTML page (Wi-Fi portal, proxy, SSO sign-in, error
  # served with 200) does not pass. The old client stays intact until the replacement.
  if ((Invoke-Tool $Node @('--check', $NewMjs)).Code -ne 0) {
    Fail 5 "$Url/brain.mjs is not the brain client (error page, Wi-Fi portal, proxy?): check the address, then run the same command again."
  }
  Move-Item -LiteralPath $NewMjs -Destination $Mjs -Force

  # Shortcuts: brain.cmd (PowerShell, cmd, Git Bash; %~dp0 = its folder) and brain (Git Bash). They work even
  # when node is not in the PATH (private copy). In a .cmd, % is written %%.
  $cmdLines = @()
  if ($CustomHome) { $cmdLines += '@setlocal'; $cmdLines += '@set "COMPANY_BRAIN_HOME=' + $BrainHome.Replace('%', '%%') + '"' }
  if ($Node -eq $PrivateNode) { $cmdLines += '@"%~dp0node\node.exe" "%~dp0brain.mjs" %*' }
  else { $cmdLines += '@"' + $Node.Replace('%', '%%') + '" "%~dp0brain.mjs" %*' }
  Write-FileAtomic (Join-Path $BrainHome 'brain.cmd') (Get-OemEncoding).GetBytes(($cmdLines -join "`r`n") + "`r`n")

  $sh = "#!/bin/sh`n"
  if ($CustomHome) { $sh += 'COMPANY_BRAIN_HOME=' + (ConvertTo-ShQuoted $BrainHome) + "`nexport COMPANY_BRAIN_HOME`n" }
  $sh += 'exec ' + (ConvertTo-ShQuoted (ConvertTo-PosixPath $Node)) + ' ' + (ConvertTo-ShQuoted ((ConvertTo-PosixPath $BrainHome) + '/brain.mjs')) + ' "$@"' + "`n"
  Write-FileAtomic (Join-Path $BrainHome 'brain') (New-Object Text.UTF8Encoding $false).GetBytes($sh)
} catch {
  Fail 4 "Unexpected error during the install: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $NewMjs -Force -ErrorAction SilentlyContinue
}

Say "Brain client installed: $(Join-Path $BrainHome 'brain.cmd') (Node.js v${NodeVer}: $Node)."
# setup output in UTF-8 if PowerShell relays it (otherwise it goes straight to the console).
$ErrorActionPreference = 'Continue'
$savedEncoding = $null
try { $savedEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
try {
  & $Node $Mjs $Command @ScriptArgs
  $code = $LASTEXITCODE
} catch {
  $code = 4
  Warn "Node.js does not start ($Node): $($_.Exception.Message)"
} finally {
  if ($savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
}
exit $code
