@echo off
setlocal
cd /d "%~dp0" || exit /b 1
set "PORT=8443"
set "HTTPS_CERT=%CD%\.tls\localhost.crt"
set "HTTPS_KEY=%CD%\.tls\localhost.key"
curl.exe --insecure --fail --silent --max-time 2 https://127.0.0.1:8443/healthz 2>nul | findstr /x /l /c:"ADB Toolkit ready" >nul
if not errorlevel 1 (
    echo ADB Toolkit is already running at https://127.0.0.1:8443/
    timeout /t 3 /nobreak >nul 2>&1
    exit /b 0
)
if not exist "%HTTPS_CERT%" goto missing
if not exist "%HTTPS_KEY%" goto missing
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js is required.
    pause
    exit /b 1
)
node server.cjs
if errorlevel 1 (
    pause
    exit /b 1
)
exit /b 0

:missing
echo Put localhost.crt and localhost.key in "%CD%\.tls".
pause
exit /b 1
