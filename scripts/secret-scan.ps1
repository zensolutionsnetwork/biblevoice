# secret-scan.ps1 - privacy/secret gate run before every git push (the deploy .bat calls this).
# DEFENSIVE TOOL: scans OUR OWN outgoing commits so we never accidentally publish our own
# credentials or private files to this public repo. It touches nothing outside this checkout.
# Scans exactly what git would publish: tracked files + untracked files NOT covered by .gitignore.
# Exit 0 = clean, exit 1 = BLOCKED (findings printed; matched values never echoed).
# Owner's rule after the backlog leak of 2026-06-06: internal state never rides along with public code.
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI).
param(
    [string]$Root = "C:\Users\MatPa\Documents\GitHub\biblevoice",
    [string]$GitExe = ""
)

$ErrorActionPreference = "Stop"
$findings = @()
Set-Location $Root

# Resolve git (GitHub Desktop bundle) if not provided.
if (-not $GitExe) {
    $ghd = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop" -Directory -Filter "app-*" | Sort-Object Name -Descending | Select-Object -First 1
    if ($ghd) { $GitExe = Join-Path $ghd.FullName "resources\app\git\mingw64\bin\git.exe" }
}

# The set of files git would publish (tracked + untracked-not-ignored).
$fileList = @()
if ($GitExe -and (Test-Path $GitExe)) {
    $fileList = (& $GitExe -C $Root ls-files --cached --others --exclude-standard) -split "`n" | Where-Object { $_ }
} else {
    Write-Output "SECRET_SCAN: WARNING - git not found, falling back to full-folder scan"
    $fileList = Get-ChildItem -Path $Root -Recurse -File | Where-Object { $_.FullName -notmatch "\\\.git\\|\\node_modules\\|\\dist\\" } | ForEach-Object { $_.FullName.Substring($Root.Length + 1) }
}

# Files that must never be publishable, even if .gitignore broke.
$forbiddenFiles = @("COUNCIL_HOMEWORK.md", "DAILY_HANDOFF.md", ".env", "typecheck.out", "typecheck.bat")

# Content patterns that indicate a secret or private document.
$patterns = @(
    @{ Name = "Anthropic API key";     Regex = "sk-ant-[A-Za-z0-9_\-]{8,}" },
    @{ Name = "Postgres/DB URL";       Regex = "postgres(ql)?://\S{8,}" },
    @{ Name = "Long hex token (32+)";  Regex = "\b[0-9a-fA-F]{32,}\b" },
    @{ Name = "Bearer token literal";  Regex = "Bearer\s+[A-Za-z0-9_\-\.]{24,}" },
    @{ Name = "Private doc marker";    Regex = "PRIVATE\s*[-]+\s*DO\s*NOT\s*PUBLISH" },
    @{ Name = "Env secret assignment"; Regex = "(ANTHROPIC_API_KEY|ADMIN_API_TOKEN|BRIDGE_SECRET|COUNCIL_JOIN_TOKEN|ADMIN_SESSION_SECRET|DATABASE_URL)\s*=\s*[A-Za-z0-9]" },
    @{ Name = "Private email (owner rule: only info@zen-ai.net may appear publicly)"; Regex = "(matpay@|mat\.pay@|@zen-solutions\.net|@hotmail\.ca)" }
)

foreach ($rel in $fileList) {
    $full = Join-Path $Root $rel
    if (-not (Test-Path $full)) { continue }
    $name = Split-Path $rel -Leaf
    if ($forbiddenFiles -contains $name) {
        $findings += ("FORBIDDEN FILE would be published: " + $rel)
        continue
    }
    # Skip bulky corpus/vendored data; binary-ish files are unlikely to regex-match anyway.
    if ($rel -match "^data/|^node_modules/|^dist/") { continue }
    # Policy files contain the patterns as literals — don't self-match.
    # (consent.json is the council v2 consent manifest; both are audited by review, not regex.)
    $relNorm = $rel -replace "\\", "/"
    if ($relNorm -eq "scripts/secret-scan.ps1" -or $relNorm -eq "consent.json") { continue }
    $item = Get-Item $full
    if ($item.Length -gt 2MB) { continue }
    $text = ""
    try { $text = [System.IO.File]::ReadAllText($full) } catch { continue }
    foreach ($p in $patterns) {
        $m = [regex]::Matches($text, $p.Regex)
        if ($m.Count -gt 0) {
            $findings += ($p.Name + " in " + $rel + " (" + $m.Count + " match)")
        }
    }
}

if ($findings.Count -gt 0) {
    Write-Output "SECRET_SCAN: BLOCKED - private content must not reach the public repo:"
    $findings | ForEach-Object { Write-Output ("  - " + $_) }
    exit 1
}
Write-Output "SECRET_SCAN: clean"
exit 0
