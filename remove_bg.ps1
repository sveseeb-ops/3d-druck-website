Add-Type -AssemblyName System.Drawing
$inPath = "c:\Users\sven-\Desktop\3D-Druck-Website\assets\images\dubbe_deckenlampe.png"
$outPath = "c:\Users\sven-\Desktop\3D-Druck-Website\assets\images\dubbe_deckenlampe_trans.png"
$bmp = New-Object System.Drawing.Bitmap($inPath)
$newBmp = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height)
for ($x = 0; $x -lt $bmp.Width; $x++) {
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        $p = $bmp.GetPixel($x, $y)
        $lum = ($p.R * 0.3 + $p.G * 0.59 + $p.B * 0.11)
        $alpha = 0
        if ($lum -gt 80) { $alpha = 255 }
        elseif ($lum -gt 25) { $alpha = [int](($lum - 25) * 255 / 55) }
        if ($alpha -lt 0) { $alpha = 0 }
        if ($alpha -gt 255) { $alpha = 255 }
        $newColor = [System.Drawing.Color]::FromArgb($alpha, $p.R, $p.G, $p.B)
        $newBmp.SetPixel($x, $y, $newColor)
    }
}
$newBmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$newBmp.Dispose()
