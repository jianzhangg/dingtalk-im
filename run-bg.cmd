@ECHO off
REM dingtalk-im-api background entry (called by Scheduled Task). No interaction, logs append to server.log
cd /d %~dp0
node server\server.mjs >> server.log 2>&1
