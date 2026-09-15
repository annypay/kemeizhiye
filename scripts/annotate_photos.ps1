# annotate_photos.ps1 — 现场照片文件名标注
#
# 用途：把某个现场照片文件夹里的 JPG 逐张加上「左上角红字文件名（不含扩展名）」
#       标注，输出到该目录下的 注释/ 子文件夹。原图只读：不改名、不改写、不移动。
#
# ⚠ 本文件必须保存为 UTF-8「带 BOM」。本机是 Windows PowerShell 5.1 + ANSI 代码页 936(GBK)，
#   .ps1 若无 BOM，PowerShell 会按 GBK 解码，脚本内的中文串会全部乱码、路径失效。
#   用 VS Code 另存时请选择「UTF-8 with BOM」，不要选「UTF-8」。
#
# 用法：
#   powershell -NoProfile -File scripts/annotate_photos.ps1 -SourceDir "C:\Users\mrseven\Pictures\20260915现场图片"
#   powershell -NoProfile -File scripts/annotate_photos.ps1 -SourceDir "<照片目录>" -DryRun   # 只预演不写盘
#
# 配套校验：scripts/verify_photo_annotations.ps1 -SourceDir "<照片目录>"
# 流程说明：.github/skills/photo-annotate/SKILL.md
#
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, HelpMessage = '照片目录（顶层 JPG；输出到该目录下的 注释/ 子目录）')]
    [string]$SourceDir,

    [string]$OutDirName = '注释',
    [int]$JpegQuality = 92,
    [double]$WidthFactor = 0.88,   # 文字可用宽度 = 图宽 × 该系数
    [double]$SizeCap = 72.0,       # 字号上限(px)，防止短文件名过大
    [double]$SizeFloor = 40.0,     # 字号参考下限(px)，硬约束（必须装下）优先
    [string]$ReportCsv,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $ReportCsv) { $ReportCsv = Join-Path $env:TEMP 'dsh_annotate\report.csv' }

# ---------------------------------------------------------------- 0. 源目录预检
if (-not (Test-Path -LiteralPath $SourceDir)) {
    Write-Output "✖ 照片目录不存在：$SourceDir"
    exit 1
}
$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
$OutDir = Join-Path $SourceDir $OutDirName

$allFiles = @(Get-ChildItem -LiteralPath $SourceDir -File | Where-Object { $_.DirectoryName -ne $OutDir })
$srcFiles = @($allFiles | Where-Object { $_.Extension -match '^\.jpe?g$' } | Sort-Object Name)

# 非 JPG 图片显式列名说明，避免"文件怎么没处理"的静默失败
$unsupported = @($allFiles | Where-Object { $_.Extension -match '^\.(heic|heif|webp|avif|png|bmp|tif|tiff|gif)$' })
if ($unsupported.Count -gt 0) {
    $byExt = $unsupported | Group-Object { $_.Extension.ToLower() } | Sort-Object Name
    Write-Output "⚠ 发现 $($unsupported.Count) 个非 JPG 图片，本次不处理："
    foreach ($g in $byExt) {
        $reason = '本流程只处理 JPG，请先转为 JPG'
        if ($g.Name -match '^\.(heic|heif|webp|avif)$') {
            $reason = 'System.Drawing(GDI+) 不支持该格式（HEIC 为手机原片常见格式），必须先转为 JPG'
        }
        Write-Output ("    {0} × {1}  —— {2}" -f $g.Name, $g.Count, $reason)
    }
}
if ($srcFiles.Count -eq 0) {
    Write-Output "✖ 目录内没有可处理的 JPG：$SourceDir"
    exit 1
}

if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        Write-Output "[init] 已创建输出目录：$OutDir"
    } else {
        $existing = @(Get-ChildItem -LiteralPath $OutDir -File -Filter *.jpg)
        if ($existing.Count -gt 0) {
            Write-Output "[init] 提示：输出目录已有 $($existing.Count) 个 JPG，同名文件将被覆盖（原图不受影响）"
        }
    }
}

# ---------------------------------------------------------------- 1. 中文字体
$preferred = @('Microsoft YaHei', 'SimHei', 'Noto Sans SC', 'Arial Unicode MS', 'SimSun')
$installed = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
$familyName = $preferred | Where-Object { $installed -contains $_ } | Select-Object -First 1
if (-not $familyName) { Write-Output "✖ 未找到可用中文字体：$($preferred -join ' / ')"; exit 1 }

# ---------------------------------------------------------------- 2. JPEG 编码器
$jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
if (-not $jpgCodec) { Write-Output '✖ 未找到 JPEG 编码器'; exit 1 }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList @(
    [System.Drawing.Imaging.Encoder]::Quality, [int64]$JpegQuality)

$redBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 0, 0))
$whiteBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::White)
$sf = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$measureBox = New-Object System.Drawing.SizeF -ArgumentList 100000.0, 100000.0
$dirs = @(@(-1, -1), @(0, -1), @(1, -1), @(-1, 0), @(1, 0), @(-1, 1), @(0, 1), @(1, 1))

function Get-FontAt([string]$family, [double]$size) {
    return (New-Object System.Drawing.Font -ArgumentList @(
            $family, [float]$size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel))
}

# ---------------------------------------------------------------- 3. EXIF 旋转
# System.Drawing 不会自动应用 EXIF 方向标记；手机原片常带 6/8（横竖颠倒）。
# 先按标记把像素摆正到"看图软件显示的方向"，再标注，并移除标记防止二次旋转。
function Get-ExifOrientation($bmp) {
    $o = 1
    try {
        foreach ($pi in $bmp.PropertyItems) {
            if ($pi.Id -eq 274 -and $pi.Value.Length -ge 2) {
                $o = [System.BitConverter]::ToUInt16($pi.Value, 0)
                break
            }
        }
    } catch { $o = 1 }
    if ($o -lt 1 -or $o -gt 8) { $o = 1 }
    return $o
}

function Invoke-ExifRotate($bmp, [int]$orientation) {
    switch ($orientation) {
        2 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX) }
        3 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        4 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipY) }
        5 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipX) }
        6 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        7 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipX) }
        8 { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    }
    try { $bmp.RemovePropertyItem(274) } catch { }
}

Write-Output "[init] 字体      ：$familyName"
Write-Output "[init] 照片目录  ：$SourceDir"
Write-Output "[init] 输出目录  ：$OutDir"
Write-Output "[init] 待处理 JPG：$($srcFiles.Count)"
if ($DryRun) { Write-Output '[init] 模式      ：DryRun（只预演，不写盘）' }

# ---------------------------------------------------------------- 4. 逐张处理
$report = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[object]
$index = 0

foreach ($file in $srcFiles) {
    $index++
    $label = $file.BaseName
    $outPath = Join-Path $OutDir ($file.BaseName + $file.Extension)

    if ([System.IO.Path]::GetFullPath($outPath) -eq [System.IO.Path]::GetFullPath($file.FullName)) {
        $failed.Add([pscustomobject]@{ Name = $file.Name; Error = '输出路径等于源路径，已跳过' })
        Write-Output ("[{0,3}/{1}] SKIP 路径冲突：{2}" -f $index, $srcFiles.Count, $file.Name)
        continue
    }

    $bmp = $null; $g = $null; $font = $null
    try {
        $bmp = New-Object System.Drawing.Bitmap -ArgumentList $file.FullName
        $ori = Get-ExifOrientation $bmp
        if ($ori -ne 1) { Invoke-ExifRotate $bmp $ori }

        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        # 本流程不做任何缩放，下面两项本无影响；显式设定是为了与已交付批次（20260915）
        # 的位图渲染状态完全一致，保证重跑产出与 注释/ 既有文件逐字节相同。
        # 注意：PixelOffsetMode 会影响抗锯齿文字的采样，改动会导致全批 JPEG 字节变化。
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        # 以摆正后的尺寸计算
        $W = $bmp.Width; $H = $bmp.Height
        $margin = [Math]::Max(24.0, [Math]::Round([Math]::Min($W, $H) * 0.025, 0))

        # 自动适配字号：先测「字宽/字号」比例，再迭代求解（含描边半径占位）
        $probe = Get-FontAt $familyName 100.0
        $mProbe = $g.MeasureString($label, $probe, $measureBox, $sf)
        $probe.Dispose()
        if ($mProbe.Width -le 0) { throw "测量失败：$label" }
        $ratio = $mProbe.Width / 100.0

        $avail = $W * $WidthFactor
        $size = [Math]::Min($avail / $ratio, $SizeCap)
        for ($i = 0; $i -lt 8; $i++) {
            $r = [Math]::Max(2.0, [Math]::Round($size / 14.0, 0))
            $solved = [Math]::Min(($avail - 2 * $r) / $ratio, $SizeCap)
            if ([Math]::Abs($solved - $size) -lt 0.5) { $size = $solved; break }
            $size = $solved
        }
        if ($size -lt 6.0) { $size = 6.0 }

        # 拟合校验：实测不越界，越界则微缩重试（硬约束优先）
        for ($i = 0; $i -lt 20; $i++) {
            $font = Get-FontAt $familyName $size
            $m = $g.MeasureString($label, $font, $measureBox, $sf)
            $r = [Math]::Max(2.0, [Math]::Round($size / 14.0, 0))
            if (($m.Width + 2 * $r) -le ($W - $margin)) { break }
            $font.Dispose(); $font = $null
            $size = $size * 0.94
        }
        $font = Get-FontAt $familyName $size
        $m = $g.MeasureString($label, $font, $measureBox, $sf)
        $haloR = [Math]::Max(2.0, [Math]::Round($size / 14.0, 0))
        $belowFloor = ($size -lt $SizeFloor)

        $x = $margin; $y = $margin
        if (-not $DryRun) {
            # 先描白边（两圈半径，边缘更实），再落红色正文
            foreach ($ring in @($haloR, [Math]::Round($haloR / 2.0, 0))) {
                if ($ring -le 0) { continue }
                foreach ($d in $dirs) {
                    $g.DrawString($label, $font, $whiteBrush, [float]($x + $d[0] * $ring), [float]($y + $d[1] * $ring), $sf)
                }
            }
            $g.DrawString($label, $font, $redBrush, [float]$x, [float]$y, $sf)
            $bmp.Save($outPath, $jpgCodec, $encParams)
        }

        $outBytes = 0
        if (-not $DryRun) { $outBytes = (Get-Item -LiteralPath $outPath).Length }
        $report.Add([pscustomobject]@{
                Name = $file.Name; Label = $label; OriExif = $ori
                Width = $W; Height = $H; FontPx = [Math]::Round($size, 1)
                HaloRadius = $haloR; Margin = $margin
                TextWidthPx = [Math]::Round($m.Width, 1); OutBytes = $outBytes
            })
        $flag = ''
        if ($ori -ne 1) { $flag += " exif=$ori" }
        if ($belowFloor) { $flag += " 字号低于参考下限${SizeFloor}" }
        Write-Output ("[{0,3}/{1}] OK  {2}  {3}x{4}  font={5:N1}px{6}" -f `
                $index, $srcFiles.Count, $file.Name, $W, $H, [Math]::Round($size, 1), $flag)
    } catch {
        $failed.Add([pscustomobject]@{ Name = $file.Name; Error = $_.Exception.Message })
        Write-Output ("[{0,3}/{1}] FAIL {2}：{3}" -f $index, $srcFiles.Count, $file.Name, $_.Exception.Message)
    } finally {
        if ($font) { $font.Dispose() }
        if ($g) { $g.Dispose() }
        if ($bmp) { $bmp.Dispose() }
    }
}

# ---------------------------------------------------------------- 5. 汇总
$report | Export-Csv -LiteralPath $ReportCsv -NoTypeInformation -Encoding UTF8
$rotated = @($report | Where-Object { $_.OriExif -ne 1 }).Count
Write-Output ''
Write-Output ("[done] 成功 {0} / {1}　失败 {2}　EXIF 摆正 {3}" -f `
        $report.Count, $srcFiles.Count, $failed.Count, $rotated)
if ($report.Count -gt 0) {
    $s = $report | Measure-Object -Property FontPx -Minimum -Maximum
    Write-Output ("[done] 字号范围：{0}px ~ {1}px" -f $s.Minimum, $s.Maximum)
}
if ($failed.Count -gt 0) {
    Write-Output '[done] 失败清单：'
    $failed | ForEach-Object { Write-Output ("   - {0}：{1}" -f $_.Name, $_.Error) }
}
Write-Output "[done] 明细报表：$ReportCsv"
if ($DryRun) { Write-Output '[done] DryRun 结束，未写入任何文件。' }

if ($failed.Count -gt 0) { exit 1 }
exit 0
