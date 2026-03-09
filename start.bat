@echo off
cd /d "C:\Users\dima\render-qa"
start "Vite Server" cmd /c "npm run dev"
:wait
powershell -Command "try { (New-Object Net.Sockets.TcpClient).Connect('localhost',5173); exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
start "" "http://localhost:5173"
