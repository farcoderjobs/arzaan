$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pid = $conn.OwningProcess
  Write-Host "Killing PID $pid holding port 3000"
  Stop-Process -Id $pid -Force
  Start-Sleep -Seconds 3
} else {
  Write-Host "No listener on port 3000"
}
