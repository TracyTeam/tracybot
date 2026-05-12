$ErrorActionPreference = "Stop" # Exit immediately if a command fails

$VsixPath = Join-Path $env:TEMP "tracy_extension_$(New-Guid).vsix"

try {
    Write-Host "Downloading latest Tracy extension..."
    Invoke-WebRequest -Uri "https://github.com/TracyTeam/tracybot/releases/latest/download/vscode-extension.vsix" -OutFile $VsixPath

    Write-Host "Installing extension in VS Code..."
    code --install-extension $VsixPath

    Write-Host "Tracy extension installed successfully!" -ForegroundColor Green
}
finally {
    # 2. Guarantee cleanup happens from the Temp folder
    if (Test-Path $VsixPath) {
        Remove-Item -Path $VsixPath -Force
    }
}
