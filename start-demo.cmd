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
echo 木脉智检正在启动：
echo   共享服务  http://localhost:8000   （配置 / 产物 / 场景的跨端状态）
echo   页面      http://localhost:5173
echo.
echo 共享服务在新窗口里跑，四台电脑要连同一场演示时把 5173 这台机器的
echo 局域网地址发给其他人（页面里的 /api 会自动打到提供页面的那台机器）。
echo 关闭本窗口即可停止页面；共享服务那个窗口要单独关。
echo.

start "mumai-shared" cmd /k ""%MUMAI_PNPM%" run server"
rem 给共享服务一点启动时间，避免页面第一次请求就打空
timeout /t 2 /nobreak >nul

call "%MUMAI_PNPM%" dev

if errorlevel 1 (
  echo.
  echo [错误] 启动失败，请检查上方日志。
  pause
)
