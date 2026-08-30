# Creates a clickable desktop shortcut for Career Watch.
#
# It targets the Electron runtime in node_modules rather than the packaged
# .exe: Smart App Control blocks freshly-built unsigned executables, and
# code-signing is not worth it for a personal tool.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'resources\icon.ico'

if (-not (Test-Path $electron)) {
  Write-Error "Electron binary missing. Run: npm run fix:electron"
  exit 1
}
if (-not (Test-Path (Join-Path $root 'out\main\index.js'))) {
  Write-Error "App not built. Run: npm run build"
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Career Watch.lnk'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $electron
$s.Arguments = '"' + $root + '"'
$s.WorkingDirectory = $root
$s.WindowStyle = 7          # start minimised; the app shows its own window
$s.Description = 'Watches company career pages for internships and new-grad roles'
if (Test-Path $icon) { $s.IconLocation = $icon }
$s.Save()

Write-Output "Shortcut created: $lnk"
Write-Output "Target: $electron"
