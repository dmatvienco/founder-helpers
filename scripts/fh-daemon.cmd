@echo off
rem founder-helpers daemon wrapper for Task Scheduler.
rem The daemon holds a lockfile, so a second start (watchdog) exits instantly.
cd /d C:\Work\founder-helpers
fh daemon >> "%LOCALAPPDATA%\founder-helpers\founder-helpers-663ba99c\logs\task-wrapper.log" 2>&1
