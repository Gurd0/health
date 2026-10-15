@echo off
rem Daily Google Health API sync. Log goes to data\sync.log.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
echo ===== %DATE% %TIME% >> data\sync.log
.venv\Scripts\python -m ingest sync >> data\sync.log 2>&1
