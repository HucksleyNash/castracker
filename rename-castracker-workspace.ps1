#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $NewName = 'Castracker'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($NewName) -or
    $NewName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    $NewName.Contains('\') -or $NewName.Contains('/')) {
    throw "'$NewName' is not a valid folder name."
}

$Source = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$Parent = [IO.Directory]::GetParent($Source).FullName
$Destination = [IO.Path]::GetFullPath((Join-Path $Parent $NewName))

if ([IO.Directory]::GetParent($Destination).FullName -ne $Parent) {
    throw 'The destination must remain in the current workspace parent directory.'
}
if (Test-Path -LiteralPath $Destination) {
    throw "The destination already exists: $Destination"
}

$running = Get-Process -Name 'deno' -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Path -and $_.Path.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)
    }
if ($running) {
    throw 'Castracker is still running. Stop its PowerShell window with Ctrl+C, then run this command again.'
}

if ($PWD.Path.StartsWith($Source, [StringComparison]::OrdinalIgnoreCase)) {
    Set-Location -LiteralPath $Parent
}

if ($PSCmdlet.ShouldProcess($Source, "Rename workspace to '$Destination'")) {
    Rename-Item -LiteralPath $Source -NewName $NewName
    Write-Host "Workspace renamed to $Destination" -ForegroundColor Green
}
