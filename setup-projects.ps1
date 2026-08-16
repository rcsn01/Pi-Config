[CmdletBinding()]
param(
	[string]$ConfigRoot = $PSScriptRoot,
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$ProjectPaths
)

# Link a project's .pi directory to this Pi-Config project's .pi.
# Run with no arguments to be prompted for project paths, or pass one or more
# project paths as arguments. Assumes this script lives in the Pi-Config root.

$ErrorActionPreference = "Stop"

$piConfigDir = (Resolve-Path -LiteralPath $ConfigRoot).Path
$targetDir = Join-Path $piConfigDir ".pi"

if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
	throw "Expected Pi config directory at: $targetDir"
}

$resolvedTarget = (Resolve-Path -LiteralPath $targetDir).Path

function Link-Project {
	param([string]$Path)

	$resolved = @(Resolve-Path -Path $Path -ErrorAction SilentlyContinue)
	if ($resolved.Count -eq 0) {
		Write-Warning "Not a directory: $Path"
		return
	}
	$projectDir = $resolved[0].Path
	if (-not (Test-Path -LiteralPath $projectDir -PathType Container)) {
		Write-Warning "Not a directory: $Path"
		return
	}

	if ([string]::Equals($projectDir, $piConfigDir, [StringComparison]::OrdinalIgnoreCase)) {
		Write-Output "skip: $projectDir is the Pi-Config project itself"
		return
	}

	$linkPath = Join-Path $projectDir ".pi"
	$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue

	if ($null -ne $existing) {
		if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			$linkTarget = @($existing.Target)[0]
			if ($linkTarget -and -not [IO.Path]::IsPathRooted($linkTarget)) {
				$linkTarget = Join-Path $projectDir $linkTarget
			}
			$resolvedLinkTarget = if ($linkTarget) {
				(Resolve-Path -LiteralPath $linkTarget -ErrorAction SilentlyContinue).Path
			}
			if ([string]::Equals($resolvedLinkTarget, $resolvedTarget, [StringComparison]::OrdinalIgnoreCase)) {
				Write-Output "ok: $projectDir/.pi already links to Pi-Config/.pi"
			} else {
				Write-Output "skip: $projectDir/.pi is already a link to another target"
			}
		} else {
			Write-Output "skip: $projectDir/.pi already exists and is not a link"
		}
		return
	}

	New-Item -ItemType Junction -Path $linkPath -Target $targetDir | Out-Null
	Write-Output "linked: $projectDir/.pi -> $targetDir"
}

if ($ProjectPaths.Count -gt 0) {
	foreach ($path in $ProjectPaths) {
		Link-Project -Path $path
	}
} else {
	while ($true) {
		$answer = Read-Host "Enter the path to a project to link (or press Enter to finish)"
		if ([string]::IsNullOrWhiteSpace($answer)) { break }
		Link-Project -Path $answer
	}
}
