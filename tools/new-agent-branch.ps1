<#
.SYNOPSIS
  为子智能体创建一个隔离的工作分支。

.DESCRIPTION
  子智能体永远不在 main 上直接开发。这个脚本负责：
    1. 确认当前工作区没有未提交的改动（否则拒绝，避免把别人的活捎带进去）
    2. 从最新的 main 拉一个 agent/<名字>-<主题> 分支
    3. 可选：同时建一个 git worktree，给子智能体独立的工作目录

.EXAMPLE
  .\tools\new-agent-branch.ps1 -Name tax -Slug vat-engine
  .\tools\new-agent-branch.ps1 -Name review -Slug criminal-checks -Worktree
#>
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Slug,
    [switch]$Worktree
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# 1. 工作区必须干净
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "✗ 工作区有未提交的改动，先把它们提交或 stash 再建分支：" -ForegroundColor Red
    $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
    exit 1
}

# 2. 基于最新 main
$current = git rev-parse --abbrev-ref HEAD
if ($current -ne "main") { git checkout main | Out-Null }
git pull --ff-only 2>$null | Out-Null

$branch = "agent/$Name-$Slug"
$exists = git branch --list $branch
if ($exists) { Fail "分支 $branch 已存在，换个主题名或先删除它" }

git checkout -b $branch | Out-Null
Write-Host "✓ 已创建并切换到 $branch" -ForegroundColor Green

# 3. 可选 worktree
if ($Worktree) {
    $dir = Join-Path (Split-Path (Get-Location) -Parent) ("accounting-" + $Name)
    if (Test-Path $dir) { Fail "目录 $dir 已存在，请先清理" }
    git worktree add $dir $branch | Out-Null
    Write-Host "✓ worktree: $dir" -ForegroundColor Green
    Write-Host "  子智能体请在该目录内工作，完成后 git worktree remove `"$dir`""
}

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 子智能体只提交自己负责的文件："
Write-Host "     git add <自己的路径> && git commit -m `"feat(scope): 说明`""
Write-Host "  2) 合并前跑：npm run typecheck; npm test; npm run check"
Write-Host "  3) 主智能体合并："
Write-Host "     git checkout main; git merge --no-ff $branch -m `"merge: ...`""
