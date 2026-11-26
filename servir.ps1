# Petit serveur local pour ouvrir la scène sur un PC hors réseau (Windows, sans installation).
# Clic droit > Exécuter avec PowerShell, puis ouvrir http://localhost:8080/ dans Edge ou Chrome.
$racine = $PSScriptRoot
$port = 8080
$types = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg';
  '.svg'='image/svg+xml'; '.txt'='text/plain; charset=utf-8'; '.wasm'='application/wasm'
}
$ecoute = New-Object System.Net.HttpListener
$ecoute.Prefixes.Add("http://localhost:$port/")
$ecoute.Start()
Write-Host "Scène servie sur http://localhost:$port/  (Ctrl+C pour arrêter)"
Start-Process "http://localhost:$port/"
while ($ecoute.IsListening) {
  $ctx = $ecoute.GetContext()
  $chemin = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($chemin -eq '') { $chemin = 'index.html' }
  $fichier = [IO.Path]::GetFullPath((Join-Path $racine $chemin))
  if ($fichier.StartsWith($racine) -and (Test-Path $fichier -PathType Leaf)) {
    $ext = [IO.Path]::GetExtension($fichier).ToLower()
    $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
    $octets = [IO.File]::ReadAllBytes($fichier)
    $ctx.Response.ContentLength64 = $octets.Length
    $ctx.Response.OutputStream.Write($octets, 0, $octets.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
