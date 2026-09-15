# verify_photo_annotations.ps1 — 现场照片标注校验
#
# 用途：校验 scripts/annotate_photos.ps1 的产出，逐张断言：
#   · 源图存在、输出无缺失/无多余/无 0 字节；
#   · 输出尺寸符合预期（源图带 EXIF 5/6/7/8 旋转标记时，长宽应已互换）；
#   · 左上区域存在足够红色像素（说明标注确实画上去了）；
#   · 红色像素包围盒落在左上，未贴边、未越界。
# 任一张不过 → 退出码 1，并输出明细 CSV。刻意做成"能失败"的校验，不是恒真检查。
#
# ⚠ 本文件必须保存为 UTF-8「带 BOM」：本机 PowerShell 5.1 + ANSI 代码页 936，
#   无 BOM 时脚本内中文会按 GBK 解码而乱码。
#
# 用法：
#   powershell -NoProfile -File scripts/verify_photo_annotations.ps1 -SourceDir "<照片目录>"
#
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [string]$OutDirName = '注释',
    [int]$MinRedPixels = 1000,
    [string]$ReportCsv
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not $ReportCsv) { $ReportCsv = Join-Path $env:TEMP 'dsh_annotate\verify.csv' }

if (-not (Test-Path -LiteralPath $SourceDir)) {
    Write-Output "✖ 照片目录不存在：$SourceDir"
    exit 1
}
$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
$OutDir = Join-Path $SourceDir $OutDirName

# ---------------------------------------------------------------- 扫描器（C#，LockBits，快）
$code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AnnoScan {
    // 返回 [红像素数, 白像素数, minX, minY, maxX, maxY, 图宽, 图高]
    public static int[] Run(string path, double wFrac, double hFrac) {
        using (Bitmap bmp = new Bitmap(path)) {
            int rw = (int)(bmp.Width * wFrac); if (rw < 1) rw = 1;
            int rh = (int)(bmp.Height * hFrac); if (rh < 1) rh = 1;
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, rw, rh),
                ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            int stride = data.Stride;
            byte[] buf = new byte[stride * rh];
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            bmp.UnlockBits(data);
            int red = 0, white = 0;
            int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
            for (int y = 0; y < rh; y++) {
                int row = y * stride;
                for (int x = 0; x < rw; x++) {
                    int o = row + x * 3;
                    byte b = buf[o], g = buf[o + 1], r = buf[o + 2];
                    if (r >= 190 && g <= 75 && b <= 75) {
                        red++;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    } else if (r >= 235 && g >= 235 && b >= 235) { white++; }
                }
            }
            if (maxX < 0) { minX = -1; minY = -1; }
            return new int[] { red, white, minX, minY, maxX, maxY, bmp.Width, bmp.Height };
        }
    }

    // 读 EXIF 方向标记（tag 274）；读不到或非法值返回 1（正常方向）
    public static int Orientation(string path) {
        using (Bitmap bmp = new Bitmap(path)) {
            try {
                foreach (PropertyItem pi in bmp.PropertyItems) {
                    if (pi.Id == 274 && pi.Value.Length >= 2) {
                        int o = BitConverter.ToUInt16(pi.Value, 0);
                        return (o >= 1 && o <= 8) ? o : 1;
                    }
                }
            } catch { }
            return 1;
        }
    }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Drawing' -Language CSharp

$outs = @(Get-ChildItem -LiteralPath $OutDir -File -Filter *.jpg -ErrorAction SilentlyContinue | Sort-Object Name)
$srcNames = @(Get-ChildItem -LiteralPath $SourceDir -File |
        Where-Object { $_.Extension -match '^\.jpe?g$' } | Select-Object -ExpandProperty Name)

if (-not (Test-Path -LiteralPath $OutDir)) {
    Write-Output "✖ 输出目录不存在（尚未标注？）：$OutDir"
    exit 1
}

$fail = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]

foreach ($o in $outs) {
    $srcPath = Join-Path $SourceDir $o.Name
    $srcOk = Test-Path -LiteralPath $srcPath

    $scan = [AnnoScan]::Run($o.FullName, 0.65, 0.25)
    $red = $scan[0]; $white = $scan[1]
    $minX = $scan[2]; $minY = $scan[3]; $maxX = $scan[4]; $maxY = $scan[5]
    $ow = $scan[6]; $oh = $scan[7]

    $sw = 0; $sh = 0; $ori = 1
    if ($srcOk) {
        $si = [System.Drawing.Image]::FromFile($srcPath)
        $sw = $si.Width; $sh = $si.Height; $si.Dispose()
        $ori = [AnnoScan]::Orientation($srcPath)
    }
    # 源图带 5/6/7/8 时，标注脚本会先把像素摆正 → 长宽互换
    $expectSwap = ($ori -ge 5)
    $expW = if ($expectSwap) { $sh } else { $sw }
    $expH = if ($expectSwap) { $sw } else { $sh }

    $problems = New-Object System.Collections.Generic.List[string]
    if (-not $srcOk) { $problems.Add('找不到同名源图') }
    if ($srcOk -and ($ow -ne $expW -or $oh -ne $expH)) {
        $problems.Add("尺寸不符：实际 ${ow}x${oh}，期望 ${expW}x${expH}（源 ${sw}x${sh}，EXIF 方向 $ori）")
    }
    if ($red -lt $MinRedPixels) { $problems.Add("红色像素过少：$red（阈值 $MinRedPixels）") }
    if ($minX -lt 20) { $problems.Add("标注贴左边：minX=$minX") }
    if ($minY -lt 20) { $problems.Add("标注贴上边：minY=$minY") }
    if ($maxY -gt 170) { $problems.Add("标注下探过深：maxY=$maxY") }
    if ($maxX -gt ($ow - 20)) { $problems.Add("标注右侧越界：maxX=$maxX") }

    if ($problems.Count -gt 0) { $fail.Add("$($o.Name)：$($problems -join '；')") }
    $rows.Add([pscustomobject]@{
            Name = $o.Name; RedPixels = $red; WhitePixels = $white
            BBox = "x=$minX..$maxX y=$minY..$maxY"; Dims = "${ow}x${oh}"
            SrcDims = "${sw}x${sh}"; ExifOri = $ori; Bytes = $o.Length
        })
}

$missing = @($srcNames | Where-Object { $n = $_; -not ($outs.Name -contains $n) })
$extra = @($outs.Name | Where-Object { $n = $_; -not ($srcNames -contains $n) })
$zero = @($outs | Where-Object { $_.Length -eq 0 })

Write-Output '================ 现场照片标注校验 ================'
Write-Output "  源目录 JPG 数    ：$($srcNames.Count)"
Write-Output "  输出 JPG 数      ：$($outs.Count)"
Write-Output "  缺失             ：$($missing.Count)"
Write-Output "  多余             ：$($extra.Count)"
Write-Output "  0 字节           ：$($zero.Count)"
if ($rows.Count -gt 0) {
    $rm = $rows | Measure-Object -Property RedPixels -Minimum -Maximum
    Write-Output "  红色像素 最小/最大：$($rm.Minimum) / $($rm.Maximum)"
    $rot = @($rows | Where-Object { $_.ExifOri -ne 1 }).Count
    Write-Output "  EXIF 摆正张数    ：$rot"
    Write-Output '  --- 样例（前 3 张）---'
    $rows | Select-Object -First 3 | ForEach-Object {
        Write-Output ("    {0,-40} red={1,-6} {2}  {3}" -f $_.Name, $_.RedPixels, $_.BBox, $_.Dims)
    }
}
if ($missing.Count -gt 0) { $missing | ForEach-Object { Write-Output "    [缺失] $_" } }
if ($extra.Count -gt 0) { $extra | ForEach-Object { Write-Output "    [多余] $_" } }

Write-Output "  单张问题数       ：$($fail.Count)"
foreach ($f in $fail) { Write-Output "    - $f" }

$ok = ($fail.Count -eq 0 -and $missing.Count -eq 0 -and $extra.Count -eq 0 -and
    $zero.Count -eq 0 -and $outs.Count -eq $srcNames.Count -and $outs.Count -gt 0)
$rows | Export-Csv -LiteralPath $ReportCsv -NoTypeInformation -Encoding UTF8
Write-Output "  明细报表         ：$ReportCsv"
if ($ok) { Write-Output '  RESULT: PASS'; exit 0 }
Write-Output '  RESULT: FAIL'
exit 1
