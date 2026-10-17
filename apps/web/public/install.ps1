# NOS Brainer : branche ce poste Windows au cerveau d'entreprise en une commande.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url https://cerveau.example.com --token cb_...
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --url https://cerveau.example.com --join cj_... --name ...
#
# Equivalent Windows de install.sh (memes options, memes codes de sortie) ; install.sh lui passe la main dans Git Bash.
# Fichier en ASCII pur : Windows PowerShell 5.1 lit un .ps1 sans BOM dans la page de code ANSI. Les messages detailles
# (avec accents) viennent du client du cerveau.
# 1. Node.js : la copie privee %USERPROFILE%\.company-brain\node si elle est a la version figee ci-dessous ; sinon un
#    Node.js >= 20 x64 installe a demeure ; sinon installe la copie privee (zip officiel, empreinte SHA-256 verifiee).
# 2. Telecharge le client du cerveau (<url>/brain.mjs), verifie que c'est bien du JavaScript, puis ecrit les raccourcis
#    brain.cmd (PowerShell, cmd, Git Bash) et brain (Git Bash).
# 3. Lance `brain setup` avec les memes options et rend son code de sortie. Avec --join (message d'equipe), lance
#    `brain join` : la demande attend qu'un admin l'accepte, puis enchaine sur setup.
#
# Codes de sortie (les memes que install.sh) :
#   0, 1, 3, 6, 7, 8  ceux de `brain setup` ou `brain join`, rendus tels quels : 0 = tout est branche ; 1 = echec
#                 (lancer `brain.cmd doctor`) ; 3 = autorisation en attente ; 6 = branche, mais sans Screenpipe ;
#                 7 = demande pas encore acceptee (relancer `brain.cmd join`) ; 8 = demande refusee.
#   2             mauvais appel : --url absent ou pas en http(s).
#   4             systeme non gere, ou Node.js impossible a installer ou a lancer ici (le message dit quoi installer).
#   5             telechargement impossible (reseau, proxy, mauvaise adresse, page d'erreur au lieu du client) :
#                 relancer la meme commande. Le client et Node.js deja installes restent intacts.
# Le jeton n'est jamais affiche.
# Tests seulement : COMPANY_BRAIN_FORCE_PRIVATE_NODE=1 ignore le Node.js du systeme (la CI teste le telechargement).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PowerShell 7.3+ : un code de sortie non nul d'un programme ne doit pas devenir une exception.
$PSNativeCommandUseErrorActionPreference = $false

$NodeVersion = '22.23.3'
# Toujours la version x64, meme sur Windows ARM64 : Screenpipe n'est publie qu'en win32-x64, et Windows 11 sur ARM
# emule le x64. Empreinte officielle (https://nodejs.org/dist/v22.23.3/SHASUMS256.txt), figee ici avec la version.
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

# powershell -File coupe un argument "-nom:valeur" en deux (PowerShell 7 perd meme les deux-points) : "--url=https://x"
# arrive en "--url=https" puis "//x". On recolle, pour lire --url= et pour passer a setup exactement ce qui a ete tape.
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

# Lance un programme et rend son code de sortie et sa sortie, sans que Windows PowerShell 5.1 change sa sortie
# d'erreur en exception.
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

# Sonde un node : version, architecture et vrai chemin (process.execPath). Ecrits dans un fichier et relus en UTF-8 :
# un chemin accentue arrive intact quelle que soit la page de code de la console. Rend $null s'il ne demarre pas.
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

# Hooks, MCP et synchro planifiee enregistrent le vrai chemin de Node.js : celui d'un gestionnaire de versions disparait
# a la prochaine mise a jour, et tout casserait sans bruit. On prend alors la copie privee.
function Test-VersionedPath([string]$Path) {
  $p = $Path.Replace('/', '\').ToLowerInvariant()
  foreach ($m in @('\nvm\', '\fnm\', '\fnm_multishells\', '\volta\', '\.volta\', '\scoop\', '\mise\')) {
    if ($p.Contains($m)) { return $true }
  }
  return $false
}

# Telechargement : 3 essais, sauf erreur definitive (4xx : adresse fausse). Rend $false, raison dans $script:DownloadError.
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

# Empreinte SHA-256 par .NET, pas par Get-FileHash : cette fonction vient d'un module que Windows PowerShell 5.1 ne
# charge pas quand il est lance depuis PowerShell 7 (PSModulePath pointe alors vers les modules de PowerShell 7), cas
# de l'outil PowerShell de Claude Code qui lance `powershell`.
function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
}

# Deplace un dossier, en reessayant : l'antivirus garde parfois quelques instants un fichier tout juste extrait.
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

# Installe la copie privee de Node.js. Rend $null si elle est en place, sinon @{ Code; Message } : rien n'a ete remplace.
function Install-PrivateNode {
  if (-not $OnWindows) {
    return @{ Code = 4; Message = 'install.ps1 installe Node.js pour Windows seulement : ailleurs, utilise install.sh.' }
  }
  $zipUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeDist.zip"
  $work = Join-Path $BrainHome "node.download.$PID"
  $zip = Join-Path $work "$NodeDist.zip"
  $out = Join-Path $work 'x'
  try {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    [void][IO.Directory]::CreateDirectory($out)
    Say "Installation de Node.js v$NodeVersion dans $PrivateDir (copie privee, sans droits administrateur)..."
    if (-not (Save-Url $zipUrl $zip)) {
      return @{ Code = 5; Message = "Telechargement impossible : $zipUrl ($script:DownloadError). Relance la meme commande." }
    }
    if ((Get-Sha256 $zip) -ne $NodeZipSha256) {
      return @{ Code = 5; Message = 'Le telechargement de Node.js ne correspond pas a son empreinte officielle (coupe, ou modifie par un proxy ?) : relance la meme commande.' }
    }
    # tar.exe de Windows (bsdtar) lit les zip et va vite ; jamais le tar de Git, qui ne les lit pas. Sinon .NET.
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
      return @{ Code = 4; Message = "Impossible d'extraire Node.js : verifie l'espace disque, puis relance la meme commande." }
    }
    # Essai avant de remplacer quoi que ce soit : une copie qui ne demarre pas ici ne prend pas la place de l'ancienne.
    $info = Get-NodeInfo (Join-Path $newDir 'node.exe')
    if (-not $info -or $info.Version -ne $NodeVersion) {
      $why = (Invoke-Tool (Join-Path $newDir 'node.exe') @('-v')).Out | Select-Object -First 1
      return @{ Code = 4; Message = "Node.js v$NodeVersion ne demarre pas sur ce poste ($why) : Windows 10 ou 11 x64 (ou Windows 11 ARM) requis. Installe Node.js 20 ou plus (https://nodejs.org), puis relance la meme commande." }
    }
    # Echange sans jamais perdre Node.js : l'ancienne copie est mise de cote, la nouvelle prend sa place, puis
    # l'ancienne est effacee. Une copie en cours d'utilisation (MCP, synchro) ne se deplace pas : on la garde.
    $old = Join-Path $BrainHome "node.old.$PID"
    if (Test-Path -LiteralPath $PrivateDir) {
      if (-not (Move-Directory $PrivateDir $old)) {
        return @{ Code = 4; Message = "Impossible de remplacer $PrivateDir (Node.js en cours d'utilisation ?) : relance la meme commande plus tard." }
      }
    }
    if (-not (Move-Directory $newDir $PrivateDir)) {
      if (Test-Path -LiteralPath $old) { [void](Move-Directory $old $PrivateDir) }
      return @{ Code = 4; Message = "Impossible d'installer Node.js dans $PrivateDir : verifie l'espace disque, puis relance la meme commande." }
    }
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    return $null
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# cmd lit un .cmd dans la page de code OEM du systeme (850 en France) : c'est celle qu'il faut pour un chemin accentue.
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

# Ecrit a cote puis remplace d'un bloc : un raccourci n'est jamais a moitie ecrit.
function Write-FileAtomic([string]$Path, [byte[]]$Bytes) {
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllBytes($tmp, $Bytes)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# C:\Users\x -> /c/Users/x (Git Bash) ; \\serveur\partage -> //serveur/partage.
function ConvertTo-PosixPath([string]$Path) {
  if ($Path -match '^([A-Za-z]):[\\/](.*)$') { return '/' + $Matches[1].ToLowerInvariant() + '/' + ($Matches[2] -replace '\\', '/') }
  return ($Path -replace '\\', '/')
}

# Entre apostrophes pour sh : espaces, $, ` ou " dans un chemin ne sont jamais interpretes.
function ConvertTo-ShQuoted([string]$Value) { return "'" + $Value.Replace("'", "'\''") + "'" }

# --- Appel ---------------------------------------------------------------------------------------------------------

$ScriptArgs = @(Repair-Arguments $RawArgs)
$Url = ''
$Command = 'setup'
for ($i = 0; $i -lt $ScriptArgs.Count; $i++) {
  if ($ScriptArgs[$i] -eq '--url' -and $i + 1 -lt $ScriptArgs.Count) { $Url = $ScriptArgs[$i + 1] }
  elseif ($ScriptArgs[$i] -like '--url=*') { $Url = $ScriptArgs[$i].Substring(6) }
  # Message d'equipe : demande a rejoindre (brain join), qui enchaine sur setup une fois acceptee.
  if ($ScriptArgs[$i] -eq '--join' -or $ScriptArgs[$i] -like '--join=*') { $Command = 'join' }
}
if (-not $Url) { Fail 2 'Usage : install.ps1 --url <adresse du cerveau> --token <jeton personnel>  (ou --join <code d''equipe>)' }
$Url = $Url.TrimEnd('/')
# Le client telecharge ici s'execute sur le poste et recoit le jeton : HTTPS obligatoire, sauf sur ce poste meme.
# La valeur recue n'est pas reaffichee : ce pourrait etre le jeton passe au mauvais endroit.
if ($Url -cmatch '^https://.') { }
elseif ($Url -cmatch '^http://(localhost|127\.0\.0\.1|\[::1\])([:/].*)?$') { }
elseif ($Url -cmatch '^http://.') { Warn "Attention : $Url n'est pas en HTTPS, le client et ton jeton passeront en clair sur le reseau." }
else { Fail 2 "--url doit etre l'adresse du cerveau, en https:// (par exemple --url https://cerveau.example.com)." }

# Windows PowerShell 5.1 : TLS 1.2 (pas toujours actif par defaut) et proxy d'entreprise avec le compte Windows.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }

# Dossier du client : celui de l'utilisateur Windows (%USERPROFILE%, celui que lit Node.js).
$CustomHome = [bool]$env:COMPANY_BRAIN_HOME
if ($CustomHome) {
  $BrainHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:COMPANY_BRAIN_HOME)
  $env:COMPANY_BRAIN_HOME = $BrainHome
} elseif ($env:USERPROFILE) {
  $BrainHome = Join-Path $env:USERPROFILE '.company-brain'
} else {
  Fail 4 "USERPROFILE n'est pas defini : impossible de trouver le dossier de l'utilisateur Windows."
}
try { [void][IO.Directory]::CreateDirectory($BrainHome) }
catch { Fail 4 "Impossible de creer $BrainHome ($($_.Exception.Message)) : verifie ses droits, puis relance la meme commande." }
$PrivateDir = Join-Path $BrainHome 'node'
$PrivateNode = Join-Path $PrivateDir 'node.exe'
$NewMjs = Join-Path $BrainHome "brain.new.$PID.mjs"
$Mjs = Join-Path $BrainHome 'brain.mjs'

try {
  # Client du cerveau, telecharge d'abord (une adresse fausse echoue tout de suite), verifie une fois Node.js trouve.
  # Le nom temporaire doit finir en .mjs : sinon node --check le lit comme du CommonJS et refuse le vrai client.
  Say "Telechargement du client du cerveau : $Url/brain.mjs"
  if (-not (Save-Url "$Url/brain.mjs" $NewMjs)) {
    Fail 5 "Telechargement impossible : $Url/brain.mjs ($script:DownloadError). Verifie le reseau, le proxy ou l'adresse du cerveau, puis relance la meme commande."
  }

  # 1. La copie privee, si elle est a la version figee.
  $Node = $null
  $NodeVer = $null
  $Private = Get-NodeInfo $PrivateNode
  if ($Private -and $Private.Major -ge 20) {
    if ($Private.Version -eq $NodeVersion) { $Node = $PrivateNode; $NodeVer = $Private.Version }
  } else {
    $Private = $null
  }
  # 2. Sinon un Node.js >= 20 x64 du systeme, installe a demeure : on enregistre son vrai chemin, pas celui du shim.
  $Fallback = $null
  if (-not $Node -and $env:COMPANY_BRAIN_FORCE_PRIVATE_NODE -ne '1') {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $sys = $null
    if ($cmd) { $sys = Get-NodeInfo $cmd.Path }
    if ($sys) {
      if ($sys.Major -lt 20) { Say "Node.js v$($sys.Version) ($($sys.Path)) est trop ancien : il faut la version 20 ou plus." }
      elseif ($OnWindows -and $sys.Arch -ne 'x64') { Say "Node.js $($sys.Path) est en $($sys.Arch) : Screenpipe n'existe qu'en x64 sous Windows." }
      elseif (Test-VersionedPath $sys.Path) {
        Say "Node.js $($sys.Path) vient d'un gestionnaire de versions : il peut disparaitre a sa prochaine mise a jour."
        $Fallback = $sys
      } else {
        $Node = $sys.Path
        $NodeVer = $sys.Version
      }
    }
  }
  # 3. Sinon la copie privee, telechargee et verifiee. Si elle ne peut pas s'installer, on garde ce qui marche deja.
  if (-not $Node) {
    $problem = Install-PrivateNode
    if (-not ($problem -is [hashtable])) {
      $Node = $PrivateNode
      $NodeVer = $NodeVersion
    } elseif ($Private) {
      Warn $problem.Message
      Warn "On continue avec la copie privee deja installee (Node.js v$($Private.Version))."
      $Node = $PrivateNode
      $NodeVer = $Private.Version
    } elseif ($Fallback) {
      Warn $problem.Message
      Warn "On continue avec $($Fallback.Path) : si une mise a jour de Node.js le supprime, relance la meme commande."
      $Node = $Fallback.Path
      $NodeVer = $Fallback.Version
    } else {
      Fail $problem.Code $problem.Message
    }
  }

  # Le client telecharge doit etre du JavaScript valide : une page HTML (portail Wi-Fi, proxy, connexion SSO, erreur
  # servie en 200) ne passe pas. L'ancien client reste intact jusqu'au remplacement.
  if ((Invoke-Tool $Node @('--check', $NewMjs)).Code -ne 0) {
    Fail 5 "$Url/brain.mjs n'est pas le client du cerveau (page d'erreur, portail Wi-Fi, proxy ?) : verifie l'adresse puis relance la meme commande."
  }
  Move-Item -LiteralPath $NewMjs -Destination $Mjs -Force

  # Raccourcis : brain.cmd (PowerShell, cmd, Git Bash ; %~dp0 = son dossier) et brain (Git Bash). Ils marchent meme
  # quand node n'est pas dans le PATH (copie privee). Dans un .cmd, % s'ecrit %%.
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
  Fail 4 "Erreur inattendue pendant l'installation : $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $NewMjs -Force -ErrorAction SilentlyContinue
}

Say "Client du cerveau installe : $(Join-Path $BrainHome 'brain.cmd') (Node.js v$NodeVer : $Node)."
# Sortie de setup en UTF-8 si PowerShell la relaie (sinon elle va directement a la console).
$ErrorActionPreference = 'Continue'
$savedEncoding = $null
try { $savedEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
try {
  & $Node $Mjs $Command @ScriptArgs
  $code = $LASTEXITCODE
} catch {
  $code = 4
  Warn "Node.js ne demarre pas ($Node) : $($_.Exception.Message)"
} finally {
  if ($savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
}
exit $code
