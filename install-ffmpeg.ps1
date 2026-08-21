#Requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ToolsDirectory = Join-Path $PSScriptRoot '.tools'
$Destination = Join-Path $ToolsDirectory 'ffmpeg'
$TemporaryDirectory = Join-Path $ToolsDirectory 'ffmpeg-install'
$ArchivePath = Join-Path $TemporaryDirectory 'ffmpeg-release-essentials.7z'
$ChecksumPath = Join-Path $TemporaryDirectory 'ffmpeg-release-essentials.7z.sha256'
$ArchiveUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z'
$ChecksumUrl = "$ArchiveUrl.sha256"
$InstallCompleted = $false

function Save-RemoteFile {
    param(
        [Parameter(Mandatory = $true)] [string] $Uri,
        [Parameter(Mandatory = $true)] [string] $Path,
        [switch] $Resume
    )

    $Curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
    if ($null -ne $Curl) {
        $CurlArguments = @(
            '--fail'
            '--location'
            '--retry'
            '8'
            '--retry-all-errors'
            '--connect-timeout'
            '30'
        )
        if ($Resume) {
            $CurlArguments += @('--continue-at', '-')
        }
        elseif (Test-Path -LiteralPath $Path) {
            Remove-Item -LiteralPath $Path -Force
        }
        $CurlArguments += @('--output', $Path, $Uri)
        & $Curl.Source @CurlArguments
        if ($LASTEXITCODE -ne 0) {
            throw "curl failed to download '$Uri' (exit code $LASTEXITCODE)."
        }
        return
    }

    Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing -TimeoutSec 600
}

try {
    New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null
    Write-Host 'Downloading FFmpeg essentials for Windows...'
    Save-RemoteFile -Uri $ChecksumUrl -Path $ChecksumPath

    $ChecksumText = Get-Content -LiteralPath $ChecksumPath -Raw -Encoding UTF8
    $Match = [regex]::Match($ChecksumText, '(?i)(?<Hash>[0-9a-f]{64})')
    if (-not $Match.Success) {
        throw 'The published FFmpeg checksum could not be parsed.'
    }
    $ExpectedHash = $Match.Groups['Hash'].Value.ToUpperInvariant()
    $ArchiveVerified = $false
    if (Test-Path -LiteralPath $ArchivePath) {
        $ArchiveVerified = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -eq $ExpectedHash
    }
    if ($ArchiveVerified) {
        Write-Host 'Using the previously downloaded, verified FFmpeg archive.'
    }
    else {
        Save-RemoteFile -Uri $ArchiveUrl -Path $ArchivePath -Resume
    }

    $ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
    if ($ActualHash -ne $ExpectedHash) {
        Remove-Item -LiteralPath $ArchivePath -Force
        throw 'FFmpeg SHA-256 verification failed. The archive was not installed.'
    }

    $Extracted = Join-Path $TemporaryDirectory 'extracted'
    if (Test-Path -LiteralPath $Extracted) {
        Remove-Item -LiteralPath $Extracted -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Extracted -Force | Out-Null
    $Tar = Get-Command 'tar.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $Tar) {
        throw 'The built-in Windows tar.exe extractor is required for the verified FFmpeg archive.'
    }
    & $Tar.Source -xf $ArchivePath -C $Extracted
    if ($LASTEXITCODE -ne 0) {
        throw "tar.exe could not extract the verified FFmpeg archive (exit code $LASTEXITCODE)."
    }
    $Ffmpeg = Get-ChildItem -LiteralPath $Extracted -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
    if ($null -eq $Ffmpeg) {
        throw 'The verified FFmpeg archive did not contain ffmpeg.exe.'
    }
    $SourceBin = $Ffmpeg.Directory.FullName
    $DestinationBin = Join-Path $Destination 'bin'
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DestinationBin -Force | Out-Null
    foreach ($Name in @('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe')) {
        $Source = Join-Path $SourceBin $Name
        if (Test-Path -LiteralPath $Source) {
            Copy-Item -LiteralPath $Source -Destination (Join-Path $DestinationBin $Name)
        }
    }
    Write-Host "Installed verified FFmpeg tools: $DestinationBin"
    $InstallCompleted = $true
}
finally {
    if ($InstallCompleted -and (Test-Path -LiteralPath $TemporaryDirectory)) {
        Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
    }
    elseif (Test-Path -LiteralPath $ArchivePath) {
        Write-Warning "FFmpeg setup was interrupted. The partial archive was kept and will resume next time: $ArchivePath"
    }
}
