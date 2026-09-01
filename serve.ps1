param(
    [string]$Root = $PSScriptRoot,
    [int]$Port = 8123,
    [switch]$NoAutoOpen
)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Appka bezi na http://localhost:$Port/  (toto okno nechaj otvorene, zatvorenim sa server vypne)"
if (-not $NoAutoOpen) { Start-Process "http://localhost:$Port/vyroba_oceanik_7.html" }

$mime = @{
    ".html" = "text/html"; ".js" = "application/javascript"; ".css" = "text/css";
    ".json" = "application/json"; ".png" = "image/png"; ".svg" = "image/svg+xml"
}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
        $path = $req.Url.LocalPath
        if ($path -eq "/") { $path = "/vyroba_oceanik_7.html" }
        $full = Join-Path $Root ($path.TrimStart("/"))
        if (Test-Path $full -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($full)
            $ct = $mime[$ext]
            if (-not $ct) { $ct = "application/octet-stream" }
            if ($ct -like "text/*") { $ct = "$ct; charset=utf-8" }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $res.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate")
            $res.ContentType = $ct
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found: $path")
            $res.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        $res.StatusCode = 500
    } finally {
        $res.OutputStream.Close()
    }
}
