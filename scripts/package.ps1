# pwsh -File .\scripts\package.ps1 -Target store -Clean
# pwsh -File .\scripts\package.ps1 -Target release -Clean

param(
    [ValidateSet("store", "release")]
    [string]$Target = "store",

    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$OutputDir = "",
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[CGO package][$Target] $Message"
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

function Should-ExcludeFile {
    param(
        [System.IO.FileSystemInfo]$Item,
        [string[]]$ExcludedNames,
        [string[]]$ExcludedExtensions
    )

    if ($ExcludedNames -contains $Item.Name) {
        return $true
    }

    if (-not $Item.PSIsContainer -and ($ExcludedExtensions -contains $Item.Extension)) {
        return $true
    }

    return $false
}

$ProjectRoot = (Resolve-Path $ProjectRoot).Path

if (-not $OutputDir) {
    $OutputDir = Join-Path $ProjectRoot "release"
}

$ManifestPath = Join-Path $ProjectRoot "manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "manifest.json not found: $ManifestPath"
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Version = [string]$Manifest.version
if (-not $Version) {
    throw "Could not read version from manifest.json"
}

$BaseName = "chatgpt-conversation-optimizer"
$BuildRoot = Join-Path $OutputDir "build"
$StageDir = Join-Path $BuildRoot "$BaseName-$Target-$Version"
$ZipPath = Join-Path $OutputDir "$BaseName-v$Version-$Target.zip"

$CommonExcludeNames = @(
    ".DS_Store",
    ".git",
    ".github",
    ".gitignore",
    ".tmp.drivedownload",
    ".tmp.driveupload",
    ".vscode",
    "docs",
    "node_modules",
    "release",
    "scripts",
    "Thumbs.db"
)

$CommonExcludeExtensions = @(
    ".ps1",
    ".sh",
    ".map"
)

$TargetExcludeNames = @()
$TargetIncludeExtraFiles = @()

switch ($Target) {
    "store" {
        $TargetExcludeNames += @(
            "CHANGELOG.md",
            "docs",
            "LICENSE",
            "PRIVACY.md",
            "README.md"
        )
    }
    "release" {
        $TargetIncludeExtraFiles += @(
        )
    }
}

$ExcludeNames = $CommonExcludeNames + $TargetExcludeNames
$ExcludeExtensions = $CommonExcludeExtensions

if ($Clean) {
    if (Test-Path -LiteralPath $BuildRoot) {
        Write-Step "Removing old build directory"
        Remove-Item -LiteralPath $BuildRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $ZipPath) {
        Write-Step "Removing old zip"
        Remove-Item -LiteralPath $ZipPath -Force
    }
}

Ensure-Directory $OutputDir
Ensure-Directory $BuildRoot
Ensure-Directory $StageDir

Write-Step "Project root: $ProjectRoot"
Write-Step "Version: $Version"
Write-Step "Stage dir: $StageDir"

$TopItems = Get-ChildItem -LiteralPath $ProjectRoot -Force

foreach ($Item in $TopItems) {
    if (Should-ExcludeFile -Item $Item -ExcludedNames $ExcludeNames -ExcludedExtensions $ExcludeExtensions) {
        Write-Step "Skipping: $($Item.Name)"
        continue
    }

    $Destination = Join-Path $StageDir $Item.Name

    if ($Item.PSIsContainer) {
        Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Recurse -Force
    } else {
        Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Force
    }
}

foreach ($ExtraFile in $TargetIncludeExtraFiles) {
    $SourcePath = Join-Path $ProjectRoot $ExtraFile
    if (Test-Path -LiteralPath $SourcePath) {
        $DestinationPath = Join-Path $StageDir $ExtraFile
        Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
        Write-Step "Included extra file: $ExtraFile"
    }
}

Write-Step "Creating zip: $ZipPath"
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -Force

Write-Step "Done"
Write-Host ""
Write-Host "ZIP: $ZipPath"
