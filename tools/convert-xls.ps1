<#
.SYNOPSIS
    把老式 .xls（Excel 97-2003 二进制格式）批量转换为 .xlsx。

.DESCRIPTION
    ExcelJS 只能读写 OOXML 格式（.xlsx），读不了 .xls 的二进制格式。
    很多银行和企业旧系统导出的仍然是 .xls，所以提供这个转换脚本。

    脚本调用本机已安装的 Excel（COM 自动化）完成转换，因此：
      - 需要本机装有 Microsoft Excel
      - 转换期间会短暂启动 Excel 进程，脚本结束时会关闭

.PARAMETER Path
    要转换的文件或目录。

.PARAMETER OutputDir
    输出目录。默认在原文件同目录下创建 xlsx 子目录。

.PARAMETER Recurse
    当 Path 是目录时，递归处理子目录。

.EXAMPLE
    .\tools\convert-xls.ps1 -Path .\samples
    把 samples 目录下的所有 .xls 转换到 samples\xlsx\

.EXAMPLE
    .\tools\convert-xls.ps1 -Path .\银行流水.xls -OutputDir .\converted
    转换单个文件到指定目录
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$OutputDir,

    [switch]$Recurse
)

$ErrorActionPreference = 'Stop'

# --- 收集待转换文件 ---
if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "路径不存在：$Path"
    exit 1
}

$item = Get-Item -LiteralPath $Path
$files = @()

if ($item.PSIsContainer) {
    $files = Get-ChildItem -LiteralPath $item.FullName -Filter '*.xls' -File -Recurse:$Recurse
    if (-not $OutputDir) {
        $OutputDir = Join-Path $item.FullName 'xlsx'
    }
}
else {
    if ($item.Extension -ne '.xls') {
        Write-Error "只支持 .xls 文件，实际为：$($item.Extension)"
        exit 1
    }
    $files = @($item)
    if (-not $OutputDir) {
        $OutputDir = Join-Path $item.DirectoryName 'xlsx'
    }
}

if ($files.Count -eq 0) {
    Write-Host '没有找到需要转换的 .xls 文件。' -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

Write-Host "待转换 $($files.Count) 个文件 → $OutputDir" -ForegroundColor Cyan

# --- 启动 Excel ---
$excel = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
}
catch {
    Write-Error "无法启动 Excel。请确认本机已安装 Microsoft Excel。（$($_.Exception.Message)）"
    exit 1
}

# xlOpenXMLWorkbook = 51
$XL_XLSX = 51

$ok = 0
$failed = 0

try {
    foreach ($file in $files) {
        $target = Join-Path $OutputDir ($file.BaseName + '.xlsx')
        Write-Host "  转换 $($file.Name) …" -NoNewline
        try {
            $workbook = $excel.Workbooks.Open($file.FullName, 0, $true)
            try {
                $workbook.SaveAs($target, $XL_XLSX)
            }
            finally {
                $workbook.Close($false)
                [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
            }
            Write-Host ' 完成' -ForegroundColor Green
            $ok++
        }
        catch {
            Write-Host " 失败：$($_.Exception.Message)" -ForegroundColor Red
            $failed++
        }
    }
}
finally {
    if ($excel) {
        $excel.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }
}

Write-Host ''
Write-Host "转换完成：成功 $ok 个，失败 $failed 个。" -ForegroundColor Cyan
if ($ok -gt 0) {
    Write-Host "接下来可以运行：node src/cli.ts `"$OutputDir`" --period YYYY-MM"
}
