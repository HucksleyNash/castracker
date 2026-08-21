#Requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int] $Port = 8787
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$BundledDeno = Join-Path $PSScriptRoot '.tools\deno.exe'
$Server = Join-Path $PSScriptRoot 'castracker\server.ts'

$Deno = if (Test-Path -LiteralPath $BundledDeno) {
    $BundledDeno
}
else {
    $DenoCommand = Get-Command 'deno' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $DenoCommand) {
        throw "Deno was not found in '.tools' or on PATH. Follow the Windows setup in README.md, then open a new terminal."
    }
    $DenoCommand.Source
}

$ConnectAddress = '127.0.0.1'
$AppUrl = "http://${ConnectAddress}:$Port"

function Test-CastrackerRunning {
    try {
        $Status = Invoke-RestMethod -UseBasicParsing -Uri "$AppUrl/api/status" -TimeoutSec 2
        return ($Status.name -eq 'Castracker')
    }
    catch {
        return $false
    }
}

function Test-TcpPortInUse {
    $Client = New-Object System.Net.Sockets.TcpClient
    try {
        $Connection = $Client.BeginConnect($ConnectAddress, $Port, $null, $null)
        if (-not $Connection.AsyncWaitHandle.WaitOne(750)) {
            return $false
        }
        $Client.EndConnect($Connection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $Client.Dispose()
    }
}

if (Test-CastrackerRunning) {
    Write-Host ''
    Write-Host '  Castracker is already running.' -ForegroundColor Yellow
    Write-Host "  Open $AppUrl in your browser." -ForegroundColor Green
    Write-Host '  Stop the original terminal with Ctrl+C if you want to restart it.' -ForegroundColor DarkGray
    Write-Host ''
    return
}

if (Test-TcpPortInUse) {
    throw "Port $Port is already being used by another application. Start Castracker with a different port, for example: .\start-castracker.ps1 -Port 8788"
}

$env:CASTRACKER_PORT = [string] $Port
Write-Host ''
Write-Host '  Castracker' -ForegroundColor Cyan
Write-Host "  Open $AppUrl in your browser" -ForegroundColor Green
Write-Host '  Press Ctrl+C here to stop the app.' -ForegroundColor DarkGray
Write-Host ''

# Deno requires its combined permission grant for UNC library paths on Windows.
# Keep Castracker local-only and run this script only from a trusted directory.
& $Deno run --allow-all $Server

if ($LASTEXITCODE -ne 0) {
    throw "Castracker stopped with exit code $LASTEXITCODE."
}
