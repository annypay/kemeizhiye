# 图集 PDF 渲染预览：导出 PDF 内嵌字体子集并用 GDI+ 实际渲染，输出预览 PNG 供人工复核。
#
# 说明：本脚本只做「能否被 GDI+ 加载并渲染」的健全性检查 + 生成预览图。
# 字形的严格正确性由 scripts/verify_album_fonts.js 逐字节比对保证
# （它把子集字形与系统原字体字形做逐字节比较）。本脚本不重复做像素级比对，
# 因为同名字体的两个 PrivateFontCollection 在 GDI+ 中会解析到同一 family，像素比对没有判别力。
#
# 用法: powershell -File scripts/verify_album_render.ps1 -PdfPath <pdf> [-PhotoDir <照片目录>]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [string]$PhotoDir = 'C:\Users\mrseven\Pictures\20260915现场图片',
    [string]$WorkDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('album-render-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$null = New-Item -ItemType Directory -Path $WorkDir -Force

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = 'C:\Program Files\nodejs\node.exe'
$verifier = Join-Path $repo 'scripts\verify_photo_album_pdf.js'

# ---- 1. 结构校验 + 导出内嵌字体子集
$fontDump = Join-Path $WorkDir 'fonts'
$env:PDF_FONT_DUMP = $fontDump
$verifyOut = & $node $verifier $PdfPath 2>&1 | Out-String
Remove-Item env:PDF_FONT_DUMP
if ($LASTEXITCODE -ne 0) { Write-Host $verifyOut; throw 'PDF 结构校验失败，终止渲染预览' }

$subsets = Get-ChildItem -LiteralPath $fontDump -Filter *.ttf
Write-Host ("导出内嵌字体子集 {0} 个：" -f $subsets.Count)
$subsets | ForEach-Object { Write-Host ("  {0}  ({1:N1} KB)" -f $_.Name, ($_.Length / 1KB)) }

# ---- 2. 用 GDI+ 加载私有字体（能加载即说明 sfnt 结构合法）
$col = New-Object System.Drawing.Text.PrivateFontCollection
foreach ($s in $subsets) { $col.AddFontFile($s.FullName) }
Write-Host ("GDI+ 私有字体集加载成功，families = {0}" -f $col.Families.Count)
foreach ($f in $col.Families) { Write-Host ("  · {0}" -f $f.Name) }

# ---- 3. 生成预览图（模拟一页图集版式）
$captions = @()
if (Test-Path -LiteralPath $PhotoDir) {
    $captions = Get-ChildItem -LiteralPath $PhotoDir -File |
        Where-Object { $_.Extension -match '^\.(jpg|jpeg|png)$' } |
        Sort-Object Name |
        Select-Object -First 6 |
        ForEach-Object -Begin { $i = 0 } -Process {
            $i++
            '图 {0}　{1}' -f $i, [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        }
}

$target = $col.Families[0]
$preview = Join-Path $WorkDir 'preview.png'
$pb = New-Object System.Drawing.Bitmap(1240, 1754)   # A4 @150dpi
$pg = [System.Drawing.Graphics]::FromImage($pb)
$pg.Clear([System.Drawing.Color]::White)
$pg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$gray = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110,110,110))
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40,40,40))
$blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(31,56,100))

$fTitle = New-Object System.Drawing.Font($target, 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$pg.DrawString('20260915 现场图集', $fTitle, $blue, 60, 60)
$fBody = New-Object System.Drawing.Font($target, 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$pg.DrawString('PDF 内嵌字体子集实际渲染效果（GDI+）：', $fBody, $gray, 60, 110)
$y = 150
foreach ($cap in $captions) { $pg.DrawString($cap, $fBody, $dark, 60, $y); $y += 34 }

if (Test-Path -LiteralPath $PhotoDir) {
    $first = Get-ChildItem -LiteralPath $PhotoDir -File | Sort-Object Name | Select-Object -First 1
    $img = [System.Drawing.Image]::FromFile($first.FullName)
    $w2 = 700; $h2 = [int]($w2 * $img.Height / $img.Width)
    $pg.DrawImage($img, 60, ($y + 20), $w2, $h2)
    $capFont = New-Object System.Drawing.Font($target, 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $pg.DrawString(('图 1　' + [System.IO.Path]::GetFileNameWithoutExtension($first.Name)), $capFont, $dark, 60, ($y + 28 + $h2))
    $img.Dispose(); $capFont.Dispose()
}
$pg.Dispose()
$pb.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
$pb.Dispose()

Write-Host ''
Write-Host '================ 渲染预览结果 ================'
Write-Host ("私有字体集 : {0} 个 family（GDI+ 可加载）" -f $col.Families.Count)
Write-Host ("预览图     : {0}" -f $preview)
Write-Host ("工作目录   : {0}" -f $WorkDir)
Write-Host '结论: 内嵌字体子集可被 GDI+ 正常加载；字形保真度见 verify_album_fonts.js。'
