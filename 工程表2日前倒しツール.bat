@echo off
rem ===== 工程表 2日前倒しツール (ハイブリッド版) ランチャ =====
chcp 65001 >nul
cd /d "%~dp0"

rem まず pythonw(コンソール無し)で起動。無ければ python で起動。
where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw "koutei_app.py"
) else (
    python "koutei_app.py"
    if errorlevel 1 pause
)
