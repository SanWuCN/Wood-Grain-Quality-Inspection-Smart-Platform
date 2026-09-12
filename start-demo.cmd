@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "MUMAI_PNPM=C:\Users\12920\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
if exist "%MUMAI_PNPM%" goto pnpm_ready

where pnpm >nul 2>nul
if not errorlevel 1 (
  set "MUMAI_PNPM=pnpm"
  goto pnpm_ready
)

echo [错误] 未找到 pnpm。
echo 请先安装 Node.js，然后运行：corepack enable
pause
exit /b 1

:pnpm_ready
if exist "node_modules" goto start_server
echo 首次运行，正在安装项目依赖...
call "%MUMAI_PNPM%" install
if errorlevel 1 (
  echo [错误] 依赖安装失败。
  pause
  exit /b 1
)

:start_server
echo.
echo 木脉智检正在启动，请在浏览器打开 http://localhost:5173
echo 关闭本窗口即可停止服务。
echo.
call "%MUMAI_PNPM%" dev --host 0.0.0.0

if errorlevel 1 (
  echo.
  echo [错误] 启动失败，请检查上方日志。
  pause
)
