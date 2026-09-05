@ECHO off
REM dingtalk-im-api foreground starter (double-click or run in terminal). Close window to stop.
cd /d %~dp0
echo [dingtalk-im] http://127.0.0.1:3777 starting... see server.log
node server\server.mjs >> server.log 2>&1
echo.
echo [dingtalk-im] exited. Last log lines:
powershell -NoProfile -Command "Get-Content server.log -Tail 20"
pause >NUL
