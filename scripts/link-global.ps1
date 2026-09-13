[CmdletBinding()]
param(
	[string]$ConfigRoot = (Split-Path -Parent $PSScriptRoot),
	[string]$AgentRoot = (Join-Path $HOME ".pi/agent")
)

# Link this Pi-Config project's global pi resources into ~/.pi/agent:
#   SYSTEM.md, extensions, profiles, skills, themes, settings.json
# Existing correct links report ok. Regular files are replaced with hard links;
# directories and links to other targets are skipped. Run from anywhere; this
# script belongs in Pi-Config/scripts.

$ErrorActionPreference = "Stop"

$piConfigDir = (Resolve-Path -LiteralPath $ConfigRoot).Path
$sourceDir = Join-Path $piConfigDir ".pi"
$agentDir = $AgentRoot
$items = @("SYSTEM.md", "extensions", "profiles", "skills", "themes", "settings.json")

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
	throw "Expected Pi config directory at: $sourceDir"
}

if (-not (Test-Path -LiteralPath $agentDir -PathType Container)) {
	throw "Expected pi agent directory at: $agentDir (is pi installed?)"
}
$agentDir = (Resolve-Path -LiteralPath $agentDir).Path

function Link-Item {
	param([string]$Name)

	$target = Join-Path $sourceDir $Name
	$linkPath = Join-Path $agentDir $Name

	if (-not (Test-Path -LiteralPath $target)) {
		Write-Warning "skip: $Name does not exist in $sourceDir"
		return
	}

	$resolvedTarget = (Resolve-Path -LiteralPath $target).Path
	$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue

	if ($null -ne $existing) {
		if ($existing.LinkType -eq "HardLink") {
			$correctTarget = @($existing.Target) | Where-Object {
				$resolved = (Resolve-Path -LiteralPath $_ -ErrorAction SilentlyContinue).Path
				[string]::Equals($resolved, $resolvedTarget, [StringComparison]::OrdinalIgnoreCase)
			}
			if ($correctTarget) {
				Write-Output "ok: $Name already linked"
			} else {
				Write-Output "skip: $linkPath is already a hard link to another target"
			}
		} elseif (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			$linkTarget = @($existing.Target)[0]
			if ($linkTarget -and -not [IO.Path]::IsPathRooted($linkTarget)) {
				$linkTarget = Join-Path $agentDir $linkTarget
			}
			$resolvedLinkTarget = if ($linkTarget) {
				(Resolve-Path -LiteralPath $linkTarget -ErrorAction SilentlyContinue).Path
			}

			if ([string]::Equals($resolvedLinkTarget, $resolvedTarget, [StringComparison]::OrdinalIgnoreCase)) {
				Write-Output "ok: $Name already linked"
			} else {
				Write-Output "skip: $linkPath is already a link to another target"
			}
		} elseif (-not (Test-Path -LiteralPath $target -PathType Container)) {
			$operationId = [guid]::NewGuid()
			$stagedLinkPath = Join-Path $agentDir (".pi-config-link-{0}-{1}" -f $Name, $operationId)
			$backupPath = Join-Path $agentDir (".pi-config-backup-{0}-{1}" -f $Name, $operationId)
			try {
				New-Item -ItemType HardLink -Path $stagedLinkPath -Target $resolvedTarget | Out-Null
				[IO.File]::Replace($stagedLinkPath, $linkPath, $backupPath)
			} catch [System.IO.IOException] {
				throw "Could not hard-link $linkPath. Hard links require the source and agent directory to be on the same drive."
			} finally {
				Remove-Item -LiteralPath $stagedLinkPath, $backupPath -Force -ErrorAction SilentlyContinue
			}
			Write-Output "replaced: $linkPath -> $resolvedTarget"
		} else {
			Write-Warning "skip: $linkPath already exists and is not a link; move or merge it manually"
		}
		return
	}

	if (Test-Path -LiteralPath $target -PathType Container) {
		New-Item -ItemType Junction -Path $linkPath -Target $resolvedTarget | Out-Null
	} else {
		try {
			New-Item -ItemType HardLink -Path $linkPath -Target $resolvedTarget | Out-Null
		} catch [System.IO.IOException] {
			throw "Could not hard-link $linkPath. Hard links require the source and agent directory to be on the same drive."
		}
	}
	Write-Output "linked: $linkPath -> $resolvedTarget"
}

foreach ($item in $items) {
	Link-Item -Name $item
}
