$port = 3001
$pid = 13476
Write-Host "Processing pid $pid for port $port"
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host "Stopping process $pid"
  Stop-Process -Id $pid -Force
  Start-Sleep -Seconds 4
} else {
  Write-Host "Process $pid already gone"
}
$net = netstat -ano 2>$null
$line = $net | Select-String ":3001"
if ($line) { Write-Host "Port 3001 still in use: $line" } else { Write-Host "Port 3001 free" }
