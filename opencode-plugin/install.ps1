$ErrorActionPreference = "Stop"

$PluginDir = Join-Path $env:USERPROFILE ".config\opencode\plugin"
$DestPath = Join-Path $PluginDir "tracybot-oc.js"
$AssetUrl = "https://github.com/TracyTeam/tracybot/releases/latest/download/tracybot-oc.js"

$TmpFile = Join-Path $env:TEMP "tracybot-oc_$(New-Guid).js"

try {
    Write-Host "Downloading latest OpenCode Tracy plugin..."
    Invoke-WebRequest -Uri $AssetUrl -OutFile $TmpFile

    Write-Host "Ensuring plugin directory exists..."
    if (-not (Test-Path $PluginDir)) {
        New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
    }

    Write-Host "Installing plugin..."
    Move-Item -Path $TmpFile -Destination $DestPath -Force

    Write-Host "OpenCode Tracy plugin installed successfully!" -ForegroundColor Green
}
finally {
    # 3. Guarantee temp file cleanup if execution is interrupted
    if (Test-Path $TmpFile) {
        Remove-Item -Path $TmpFile -Force
    }
}
