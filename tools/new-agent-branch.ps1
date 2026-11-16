<#
.SYNOPSIS
  为子智能体创建一个隔离的工作分支。

.DESCRIPTION
  子智能体永远不在 main 上直接开发。这个脚本负责：
    1. 确认工作区没有未提交的改动（避免把别人的活捎带进去）
    2. 从最新的 main 拉一个 agent/<名字>-<主题> 分支
    3. 可选：同时建一个 git worktree，给子智能体独立的工作目录

  注意：本文件必须保存为「UTF-8 带 BOM」。
  Windows PowerShell 5.1 在没有 BOM 时会按系统本地编码（GBK）读取，
  中文会被拆成半个字节，导致字符串引号被吞掉、报「缺少终止符」。

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
$quote = [char]34

function Fail([string]$Message) {
    Write-Host ("[x] " + $Message) -ForegroundColor Red
    exit 1
}

# 1. 工作区必须干净：否则新建分支会把别人的未提交改动一起带走
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Host "[x] 工作区有未提交的改动，先提交或 stash 再建分支：" -ForegroundColor Red
    $dirty | Select-Object -First 10 | ForEach-Object { Write-Host ("    " + $_) }
    exit 1
}

# 2. 基于最新 main
$current = (git rev-parse --abbrev-ref HEAD).Trim()
if ($current -ne "main") { git checkout main | Out-Null }
git pull --ff-only 2>$null | Out-Null

$branch = "agent/" + $Name + "-" + $Slug
$existing = git branch --list $branch
if ($existing) { Fail ("分支 " + $branch + " 已存在，换个主题名或先删除它") }

git checkout -b $branch | Out-Null
Write-Host ("[ok] 已创建并切换到 " + $branch) -ForegroundColor Green

# 3. 可选 worktree
if ($Worktree) {
    $parent = Split-Path (Get-Location) -Parent
    $dir = Join-Path $parent ("accounting-" + $Name)
    if (Test-Path $dir) { Fail ("目录 " + $dir + " 已存在，请先清理") }
    git worktree add $dir $branch | Out-Null
    Write-Host ("[ok] worktree: " + $dir) -ForegroundColor Green
    Write-Host ("     子智能体在该目录内工作，完成后执行：git worktree remove " + $dir)
}

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 子智能体只提交自己负责的文件："
Write-Host ("     git add <自己的路径> ; git commit -m " + $quote + "feat(scope): 说明" + $quote)
Write-Host "  2) 合并前跑：npm run typecheck ; npm test ; npm run check"
Write-Host "  3) 主智能体合并："
Write-Host ("     git checkout main ; git merge --no-ff " + $branch + " -m " + $quote + "merge: ..." + $quote)

