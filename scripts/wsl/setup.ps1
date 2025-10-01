# scripts/wsl/setup.ps1
# --------------------------------------------
# Windows 用: WSL(Ubuntu) の導入～初期化～依存導入(bootstrap.sh 呼び出し)
# 管理者権限 PowerShell での実行を推奨します。
# 使い方:
#   1) このリポジトリ直下で右クリック → 「PowerShell で実行」
#   2) もしくは PowerShell(管理者) で:  .\scripts\wsl\setup.ps1
# --------------------------------------------

param(
    [switch]$SkipUbuntuInstall = $false,    # 既に Ubuntu を入れている場合に指定
    [switch]$SkipBootstrap = $false         # bootstrap.sh を実行しない
)

$ErrorActionPreference = "Stop"

function Write-Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn($m){ Write-Host "!!  $m" -ForegroundColor Yellow }
function Write-OK($m){ Write-Host "✔   $m" -ForegroundColor Green }
function Throw-IfFailed($msg){
    if ($LASTEXITCODE -ne 0) { throw $msg }
}

# --- 0) 管理者判定 ---
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $IsAdmin) {
    Write-Warn "管理者権限での実行を推奨します（WSL 機能有効化に必要な場合があります）。"
}

# --- 1) wsl.exe の存在確認 ---
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Info "wsl.exe が見つかりません。Windows の省略パスが壊れている可能性があります。"
    Write-Info "Windows の機能『Linux 用 Windows サブシステム』を有効化して再試行してください。"
    throw "wsl.exe not found"
}

# --- 2) WSL/VirtualMachinePlatform 機能を有効化（必要なら）---
try {
    Write-Info "WSL/VirtualMachinePlatform を有効化（必要な場合のみ）..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    Write-OK "機能の有効化コマンドを実行しました。"
} catch {
    Write-Warn "機能の有効化でエラーが発生しました。旧バージョンの Windows の可能性があります。続行します。"
}

# --- 3) 可能なら WSL2 を既定に ---
try {
    Write-Info "WSL の既定バージョンを 2 に設定..."
    wsl --set-default-version 2 | Out-Null
    Write-OK "WSL2 を既定に設定しました。"
} catch {
    Write-Warn "WSL2 既定設定に失敗しました（無視して続行）。"
}

# --- 4) Ubuntu の導入（未インストール時）---
function Test-UbuntuInstalled {
    try {
        $list = wsl -l -v 2>$null
        return ($list -match "Ubuntu")
    } catch { return $false }
}

$ubuntuInstalled = Test-UbuntuInstalled
if (-not $ubuntuInstalled -and -not $SkipUbuntuInstall) {
    Write-Info "Ubuntu をインストールします（Windows が再起動を要求する場合があります）..."
    try {
        wsl --install -d Ubuntu
        Write-OK "Ubuntu のインストールコマンドを実行しました。"
        Write-Warn "初回セットアップのため、Windows の再起動や Ubuntu 初回起動でのユーザ作成が必要になる場合があります。"
    } catch {
        Write-Warn "wsl --install が失敗しました。Microsoft Store から『Ubuntu』を手動インストールしてください。"
        throw
    }
} else {
    Write-OK "Ubuntu は既に導入済みのようです。"
}

# --- 5) Ubuntu が起動可能か軽く確認 ---
try {
    Write-Info "Ubuntu 側の簡易コマンドを実行（起動可否チェック）..."
    wsl -d Ubuntu -e bash -lc "echo 'WSL is ready: ' \$(uname -a)" | Out-Null
    Write-OK "Ubuntu は起動可能です。"
} catch {
    Write-Warn "Ubuntu の起動確認に失敗。初回起動を行ってユーザ作成後に再実行してください。"
    throw
}

# --- 6) リポジトリパス → WSL パスへ変換 ---
function Convert-ToWslPath([string]$winPath){
    $full = (Resolve-Path $winPath).Path
    $drive = $full.Substring(0,1).ToLower()
    $rest  = $full.Substring(2).Replace('\','/')
    return "/mnt/$drive$rest"
}

$repoWin = (Resolve-Path "$PSScriptRoot\..\..").Path   # scripts\wsl\setup.ps1 から見てリポジトリルート
$repoWsl = Convert-ToWslPath $repoWin
$bootstrapWsl = "$repoWsl/scripts/wsl/bootstrap.sh"

# --- 7) bootstrap.sh の実行（依存導入・鍵設定など）---
if (-not $SkipBootstrap) {
    Write-Info "Ubuntu 内で bootstrap.sh を実行し、依存を導入します..."
    try {
        wsl -d Ubuntu -e bash -lc "chmod +x '$bootstrapWsl' && '$bootstrapWsl' '$repoWsl'"
        Throw-IfFailed "bootstrap.sh の実行に失敗しました。"
        Write-OK "bootstrap.sh 実行完了。"
    } catch {
        Write-Warn "bootstrap.sh の実行に失敗しました。Ubuntu 端末で手動実行してください:"
        Write-Host "  bash $bootstrapWsl" -ForegroundColor Yellow
        throw
    }
} else {
    Write-Warn "SkipBootstrap が指定されたため、bootstrap.sh は実行しません。"
}

# --- 8) 依存確認（rsync/ssh）---
try {
    Write-Info "WSL 内の依存確認（rsync / ssh）..."
    wsl -d Ubuntu -e bash -lc "command -v rsync >/dev/null && command -v ssh >/dev/null"
    Throw-IfFailed "rsync / ssh が見つかりません。bootstrap.sh を確認してください。"
    Write-OK "rsync / ssh の確認 OK。"
} catch {
    Write-Warn "依存確認に失敗しました。Ubuntu で以下を実行してください:"
    Write-Host "  sudo apt-get update -y && sudo apt-get install -y rsync openssh-client" -ForegroundColor Yellow
    throw
}

# --- 9) 使い方の最終案内 ---
Write-Host ""
Write-OK "WSL セットアップ完了。次のステップ:"
Write-Host "  1) Ubuntu アプリを起動" -ForegroundColor Cyan
Write-Host "  2) 環境変数のロード（初回のみ）:" -ForegroundColor Cyan
Write-Host ("     source {0}/scripts/wsl/env.example.wsl" -f $repoWsl) -ForegroundColor Yellow
Write-Host "  3) rsync/ssh の疎通テスト:" -ForegroundColor Cyan
Write-Host ("     bash {0}/scripts/wsl/relay_test.sh" -f $repoWsl) -ForegroundColor Yellow
Write-Host ""
Write-OK "セットアップ成功！"
