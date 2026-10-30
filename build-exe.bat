@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo 找不到 .NET Framework 编译器：%CSC%
  pause
  exit /b 1
)

if not exist "dist" mkdir "dist"

"%CSC%" /nologo /target:winexe /win32icon:"icon.ico" /optimize+ /platform:anycpu /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:"dist\QrScan.exe" ^
  /resource:"index.html",www.index.html ^
  /resource:"styles.css",www.styles.css ^
  /resource:"app\app.js",www.app.app.js ^
  /resource:"app\decode.js",www.app.decode.js ^
  /resource:"vendor\jsQR.js",www.vendor.jsQR.js ^
  /resource:"tests\fixtures\link.png",www.tests.fixtures.link.png ^
  /resource:"tests\fixtures\wifi.png",www.tests.fixtures.wifi.png ^
  "src\Program.cs"

if errorlevel 1 (
  echo.
  echo 编译失败
  pause
  exit /b 1
)

if exist "dist\扫码器.exe" (
  taskkill /IM "扫码器.exe" /F >nul 2>&1
  timeout /t 1 /nobreak >nul
  del /f /q "dist\扫码器.exe" >nul 2>&1
)
ren "dist\QrScan.exe" "扫码器.exe"
if exist "dist\QrScan.exe" (
  echo 旧文件还在运行，没能改名。先把扫码器.exe 关掉，再重新运行本脚本。
  pause
  exit /b 1
)
echo.
echo 编译完成：dist\扫码器.exe
endlocal
