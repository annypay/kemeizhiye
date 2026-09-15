<#
.SYNOPSIS
    现场图集 PDF 生成器（Word COM 自动化）。

.DESCRIPTION
    把某个现场照片文件夹里的图片按文件名顺序排版成一本 A4 PDF 图集：
      · 封面：图集名称、拍摄日期、照片数量、来源目录、编制部门与日期；
      · 正文：每页 1 张照片，照片下方为图注「图 N　<原文件名>」；
      · 页眉：图集名称；页脚：编制单位 + 第 X 页 / 共 Y 页。

    文件名的信息量就是图注内容，因此脚本不改名、不猜测内容，只忠实引用文件名。

.PARAMETER SourceDir
    照片源目录（只读，不会被修改）。

.PARAMETER OutputPdf
    输出 PDF 路径（可为相对路径）。

.PARAMETER Title
    图集名称（封面大标题、页眉）。

.PARAMETER ShootDate
    拍摄日期（YYYYMMDD 或 YYYY-MM-DD），仅用于封面文字。

.PARAMETER PhotoWidthCm
    照片显示宽度（厘米）。宽度固定，高度按原始比例计算。

.PARAMETER MaxPhotoHeightCm
    照片显示高度上限（厘米），超出则等比缩小以适配页面。

.EXAMPLE
    pwsh -File scripts/generate_photo_album_pdf.ps1 `
        -SourceDir "C:\Users\mrseven\Pictures\20260915现场图片" `
        -OutputPdf "00-临时存放\20260915-总经办-现场图集.pdf" `
        -Title "20260915 现场图集" -ShootDate 20260915
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$OutputPdf,
    [string]$Title = '现场图集',
    [string]$ShootDate = '',
    [double]$PhotoWidthCm = 15.0,
    [double]$MaxPhotoHeightCm = 11.0,
    [string]$ProjectName = '江西柯美纸业年产30万吨包装用纸及特种纸生产线项目二期',
    [string]$Department = '江西柯美纸业 · 总经办'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 常量（Word COM 枚举值）
# 说明：不加载 Word 互操作程序集，直接使用枚举数值，脚本可在任意装有 Word 的机器运行。
$wdCollapseEnd          = 0    # wdCollapseEnd
$wdPageBreak            = 7    # wdPageBreak
$wdAlignParagraphLeft   = 0    # wdAlignParagraphLeft
$wdAlignParagraphCenter = 1    # wdAlignParagraphCenter
$wdAlignParagraphRight  = 2    # wdAlignParagraphRight
$wdLineSpaceSingle      = 0    # wdLineSpaceSingle
$wdLineSpaceExactly     = 4    # wdLineSpaceExactly
$wdExportFormatPDF      = 17   # wdExportFormatPDF
$wdFieldPage            = 33   # wdFieldPage
$wdFieldNumPages        = 26   # wdFieldNumPages
$wdStatisticPages       = 2    # wdStatisticPages
$wdBorderBottom         = -3   # wdBorderBottom

# 版式
$cmToPt = 28.3464567
$pageWidthCm  = 21.0
$pageHeightCm = 29.7
$marginCm     = 2.0
$headerDistCm = 1.1
$footerDistCm = 1.1

# 配色（Word Font.Color 为 BGR）
$inkTitle   = 0x64381F   # 深蓝 1F3864
$inkBody    = 0x000000
$inkCaption = 0x4D4D4D   # 深灰 4D4D4D
$inkSection = 0x7A4520   # 中蓝 20457A
$inkRule    = 0x999999

# ---------------------------------------------------------------- 源目录校验
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "源目录不存在：$SourceDir"
}

$photos = Get-ChildItem -LiteralPath $SourceDir -File |
    Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|bmp|tif|tiff)$' } |
    Sort-Object Name

if ($photos.Count -eq 0) { throw "源目录没有可用图片：$SourceDir" }

# ---------------------------------------------------------------- 读取像素尺寸
function Get-ImagePixelSize {
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $br = New-Object System.IO.BinaryReader($fs)
        $b0 = $br.ReadByte(); $b1 = $br.ReadByte()
        if ($b0 -eq 0xFF -and $b1 -eq 0xD8) {          # JPEG
            while ($fs.Position -lt $fs.Length - 1) {
                if ($br.ReadByte() -ne 0xFF) { continue }
                $marker = $br.ReadByte()
                if ($marker -ge 0xC0 -and $marker -le 0xCF -and
                    $marker -ne 0xC4 -and $marker -ne 0xC8 -and $marker -ne 0xCC) {
                    $null = $br.ReadBytes(3)
                    $h = ([int]$br.ReadByte() -shl 8) + $br.ReadByte()
                    $w = ([int]$br.ReadByte() -shl 8) + $br.ReadByte()
                    return @{ W = $w; H = $h }
                }
                $lenBytes = $br.ReadBytes(2)
                $len = ([int]$lenBytes[0] -shl 8) + $lenBytes[1]
                $null = $br.ReadBytes($len - 2)
            }
        }
        elseif ($b0 -eq 0x89 -and $b1 -eq 0x50) {        # PNG
            $null = $br.ReadBytes(16)
            $wBytes = $br.ReadBytes(4); $hBytes = $br.ReadBytes(4)
            [array]::Reverse($wBytes); [array]::Reverse($hBytes)
            return @{ W = [BitConverter]::ToUInt32($wBytes, 0); H = [BitConverter]::ToUInt32($hBytes, 0) }
        }
        return @{ W = 0; H = 0 }
    }
    finally { $fs.Dispose() }
}

$sizes = @{}
foreach ($p in $photos) { $sizes[$p.FullName] = Get-ImagePixelSize -Path $p.FullName }

$plan = foreach ($p in $photos) {
    $px = $sizes[$p.FullName]
    $h = if ($px.W -gt 0 -and $px.H -gt 0) { $PhotoWidthCm * $px.H / $px.W } else { $PhotoWidthCm * 0.75 }
    if ($h -gt $MaxPhotoHeightCm) { $h = $MaxPhotoHeightCm }
    [pscustomobject]@{ File = $p; Height = [math]::Round($h, 2) }
}

$outFull = [System.IO.Path]::GetFullPath($OutputPdf)
$outDir = [System.IO.Path]::GetDirectoryName($outFull)
if (-not (Test-Path -LiteralPath $outDir)) { $null = New-Item -ItemType Directory -Path $outDir -Force }

Write-Host "源目录  ：$SourceDir"
Write-Host "照片数量：$($photos.Count)"
Write-Host "输出    ：$outFull"

# ---------------------------------------------------------------- Word 排版
$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.ScreenUpdating = $false

    $doc = $word.Documents.Add()

    # 页面设置：A4 纵向
    $ps = $doc.PageSetup
    $ps.PageWidth      = $pageWidthCm * $cmToPt
    $ps.PageHeight     = $pageHeightCm * $cmToPt
    $ps.TopMargin      = $marginCm * $cmToPt
    $ps.BottomMargin   = $marginCm * $cmToPt
    $ps.LeftMargin     = $marginCm * $cmToPt
    $ps.RightMargin    = $marginCm * $cmToPt
    $ps.HeaderDistance = $headerDistCm * $cmToPt
    $ps.FooterDistance = $footerDistCm * $cmToPt

    # 默认样式：正文仿宋 + 西文 Times New Roman（与库内 Word 规范一致）
    $normal = $doc.Styles.Item(-1)
    $normal.Font.NameFarEast = '仿宋'
    $normal.Font.NameAscii   = 'Times New Roman'
    $normal.Font.NameOther   = 'Times New Roman'
    $normal.Font.Size        = 12
    $normal.ParagraphFormat.Alignment = $wdAlignParagraphLeft
    $normal.ParagraphFormat.LineSpacingRule = $wdLineSpaceSingle

    # ---- 页眉：图集名（下边框细分隔线）
    $header = $doc.Sections.Item(1).Headers.Item(1)
    $header.Range.Text = ''
    $hr = $header.Range
    $hr.ParagraphFormat.Alignment = $wdAlignParagraphRight
    $hr.Font.NameFarEast = '微软雅黑'
    $hr.Font.NameAscii   = 'Microsoft YaHei'
    $hr.Font.Size = 9
    $hr.Font.Color = $inkCaption
    $hr.InsertAfter($Title)
    $hb = $header.Range.ParagraphFormat.Borders.Item($wdBorderBottom)
    $hb.LineStyle = 1
    $hb.LineWidth = 4
    $hb.Color = $inkRule

    # ---- 页脚：单位名 + 第 X 页 / 共 Y 页
    $footer = $doc.Sections.Item(1).Footers.Item(1)
    $footer.Range.Text = ''
    $fr = $footer.Range
    $fr.ParagraphFormat.Alignment = $wdAlignParagraphCenter
    $fr.Font.NameFarEast = '微软雅黑'
    $fr.Font.NameAscii   = 'Microsoft YaHei'
    $fr.Font.Size = 9
    $fr.Font.Color = $inkCaption
    $fr.InsertAfter("$Department    第 ")
    $null = $doc.Fields.Add($footer.Range, $wdFieldPage, $null, $true)
    $footer.Range.InsertAfter(" 页 / 共 ")
    $null = $doc.Fields.Add($footer.Range, $wdFieldNumPages, $null, $true)
    $footer.Range.InsertAfter(" 页")
    $footer.Range.Font.NameFarEast = '微软雅黑'
    $footer.Range.Font.NameAscii   = 'Microsoft YaHei'
    $footer.Range.Font.Size = 9
    $footer.Range.Font.Color = $inkCaption

    # ---------------------------------------------------------- 段落工具
    function Add-Para {
        param(
            [string]$Text = '',
            [string]$Font = '仿宋',
            [double]$Size = 12,
            [int]$Align = 0,
            [bool]$Bold = $false,
            [int]$Color = 0,
            [double]$SpaceBefore = 0,
            [double]$SpaceAfter = 0,
            [double]$LineSpacing = 0,
            [double]$IndentLeftCm = 0
        )
        $rng = $doc.Content
        $rng.Collapse($wdCollapseEnd) | Out-Null
        $rng.InsertParagraphAfter()
        $p = $doc.Paragraphs.Item($doc.Paragraphs.Count)
        if ($Text) { $p.Range.Text = $Text }
        $f = $p.Range.Font
        $f.NameFarEast = $Font
        $f.NameAscii   = if ($Font -eq '仿宋') { 'Times New Roman' } else { 'Microsoft YaHei' }
        $f.NameOther   = $f.NameAscii
        $f.Size = $Size
        $f.Bold = if ($Bold) { -1 } else { 0 }
        $f.Color = $Color
        $pf = $p.Format
        $pf.Alignment = $Align
        $pf.SpaceBefore = $SpaceBefore
        $pf.SpaceAfter = $SpaceAfter
        if ($LineSpacing -gt 0) {
            $pf.LineSpacingRule = $wdLineSpaceExactly
            $pf.LineSpacing = $LineSpacing
        }
        else { $pf.LineSpacingRule = $wdLineSpaceSingle }
        if ($IndentLeftCm -gt 0) { $pf.LeftIndent = $IndentLeftCm * $cmToPt }
        return $p
    }

    function Add-Rule {
        $p = Add-Para -Text '' -Size 6 -SpaceBefore 6 -SpaceAfter 10
        $b = $p.Format.Borders.Item($wdBorderBottom)
        $b.LineStyle = 1
        $b.LineWidth = 6
        $b.Color = $inkRule
        return $p
    }

    # 结束当前页（插入分页符）
    function Add-PageBreak {
        $doc.Content.InsertParagraphAfter()
        $p = $doc.Paragraphs.Item($doc.Paragraphs.Count)
        $p.Range.InsertBreak($wdPageBreak)
    }

    # ---------------------------------------------------------- 封面
    $null = Add-Para -Text '' -Size 12
    $null = Add-Para -Text '' -Size 12
    $null = Add-Para -Text $ProjectName -Font '微软雅黑' -Size 11 -Align $wdAlignParagraphCenter `
        -Color $inkCaption -SpaceAfter 26
    $null = Add-Para -Text $Title -Font '黑体' -Size 30 -Align $wdAlignParagraphCenter `
        -Bold $true -Color $inkTitle -SpaceBefore 24 -SpaceAfter 10
    $null = Add-Para -Text '现场施工情况照片汇编' -Font '微软雅黑' -Size 15 -Align $wdAlignParagraphCenter `
        -Color $inkCaption -SpaceAfter 8
    $null = Add-Rule

    $shootText = if ($ShootDate) {
        if ($ShootDate -match '^\d{8}$') {
            '{0}年{1}月{2}日' -f $ShootDate.Substring(0,4), $ShootDate.Substring(4,2), $ShootDate.Substring(6,2)
        } else { $ShootDate }
    } else { '（未标注）' }

    $infoLines = @(
        @{ K = '拍摄日期'; V = $shootText },
        @{ K = '照片数量'; V = "$($photos.Count) 张" },
        @{ K = '图注说明'; V = '照片下方图注即该照片的文件名，文件名已按拍摄部位与内容命名' },
        @{ K = '图片目录'; V = $SourceDir },
        @{ K = '编制部门'; V = $Department },
        @{ K = '编制日期'; V = (Get-Date).ToString('yyyy年MM月dd日') }
    )
    foreach ($line in $infoLines) {
        $null = Add-Para -Text ("{0}：{1}" -f $line.K, $line.V) -Font '微软雅黑' -Size 11 `
            -Align $wdAlignParagraphLeft -Color $inkBody -SpaceAfter 6 -LineSpacing 20 -IndentLeftCm 1.6
    }

    $null = Add-Para -Text '' -Size 12
    $null = Add-Para -Text '本图集用于现场情况说明与内部沟通，照片内容以原始文件为准。' `
        -Font '仿宋' -Size 10.5 -Align $wdAlignParagraphCenter -Color $inkCaption -SpaceBefore 22

    Add-PageBreak

    # ---------------------------------------------------------- 正文：一页一图
    $null = Add-Para -Text "现场照片（共 $($photos.Count) 张）" -Font '黑体' -Size 14 `
        -Align $wdAlignParagraphLeft -Bold $true -Color $inkSection -SpaceAfter 8

    $index = 0
    foreach ($item in $plan) {
        $index++
        $file    = $item.File
        $caption = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)

        # 1) 若本页已有图片，先分页
        if ($index -gt 1) { Add-PageBreak }

        # 2) 插入照片（居中）
        $rng = $doc.Content
        $rng.Collapse($wdCollapseEnd) | Out-Null
        $shape = $doc.InlineShapes.AddPicture($file.FullName, $false, $true, $rng)
        $shape.LockAspectRatio = -1
        $shape.Width  = $PhotoWidthCm * $cmToPt
        $shape.Height = $item.Height * $cmToPt

        $picPara = $doc.Paragraphs.Item($doc.Paragraphs.Count)
        $picPara.Format.Alignment = $wdAlignParagraphCenter
        $picPara.Format.SpaceBefore = 0
        $picPara.Format.SpaceAfter = 0
        $picPara.Format.LineSpacingRule = $wdLineSpaceSingle

        # 3) 图注：紧贴照片下方，格式为「图 N　文件名」
        $capPara = Add-Para -Text ("图 {0}　{1}" -f $index, $caption) -Font '黑体' -Size 11.5 `
            -Align $wdAlignParagraphCenter -Color $inkCaption -SpaceBefore 8 -SpaceAfter 0 -LineSpacing 18

        if ($index % 10 -eq 0) { Write-Host "  已排版 $index / $($plan.Count)" }
    }

    Write-Host '排版完成，正在导出 PDF ...'
    $doc.Repaginate()
    $pages = $doc.ComputeStatistics($wdStatisticPages)
    Write-Host "Word 统计页数：$pages"

    $doc.ExportAsFixedFormat($outFull, $wdExportFormatPDF, $false, 0, 0, 1, 0, 0,
        $true, $true, 0, $true, $true, $false)
    Write-Host "PDF 已导出：$outFull"
}
finally {
    if ($doc)  { $doc.Close(0) }
    if ($word) { $word.Quit() }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

# ---------------------------------------------------------------- 结果核对
$fi   = Get-Item -LiteralPath $outFull
$head = [System.IO.File]::ReadAllBytes($outFull)
$isPdf = ($head[0] -eq 0x25 -and $head[1] -eq 0x50 -and $head[2] -eq 0x44 -and $head[3] -eq 0x46)
$text = [System.Text.Encoding]::ASCII.GetString($head)
$pageCount = ([regex]::Matches($text, '/Type\s*/Page[^s]')).Count

Write-Host ''
Write-Host '================ 结果 ================'
Write-Host ("输出文件   : {0}" -f $fi.FullName)
Write-Host ("文件大小   : {0:N2} MB" -f ($fi.Length / 1MB))
Write-Host ("PDF 头有效 : {0}" -f $isPdf)
Write-Host ("页面对象数 : {0}" -f $pageCount)
Write-Host ("照片数量   : {0}" -f $plan.Count)
