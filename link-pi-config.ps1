[CmdletBinding()]
param(
	[string]$ConfigRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$piConfigDir = (Resolve-Path -LiteralPath $ConfigRoot).Path
$projectsDir = Split-Path -Parent $piConfigDir
$piConfigName = Split-Path -Leaf $piConfigDir
$targetDir = Join-Path $piConfigDir ".pi"

if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
	throw "Expected Pi config directory at: $targetDir"
}

$resolvedTarget = (Resolve-Path -LiteralPath $targetDir).Path

foreach ($projectDir in Get-ChildItem -LiteralPath $projectsDir -Directory) {
	if ($projectDir.FullName -eq $piConfigDir) {
		continue
	}

	$linkPath = Join-Path $projectDir.FullName ".pi"
	$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue

	if ($null -ne $existing) {
		if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			$linkTarget = @($existing.Target)[0]
			if ($linkTarget -and -not [IO.Path]::IsPathRooted($linkTarget)) {
				$linkTarget = Join-Path $projectDir.FullName $linkTarget
			}
			$resolvedLinkTarget = if ($linkTarget) {
				(Resolve-Path -LiteralPath $linkTarget -ErrorAction SilentlyContinue).Path
			}
			if ([string]::Equals($resolvedLinkTarget, $resolvedTarget, [StringComparison]::OrdinalIgnoreCase)) {
				Write-Output "ok: $($projectDir.Name)/.pi already links to $piConfigName/.pi"
			} else {
				Write-Output "skip: $($projectDir.Name)/.pi is already a link to another target"
			}
		} else {
			Write-Output "skip: $($projectDir.Name)/.pi already exists and is not a link"
		}
		continue
	}

	New-Item -ItemType Junction -Path $linkPath -Target $targetDir | Out-Null
	Write-Output "linked: $($projectDir.Name)/.pi -> $targetDir"
}