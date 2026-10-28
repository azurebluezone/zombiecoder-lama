@echo off
rem Starts the lama management wrapper relative to this file's location.
rem Env vars for Windows are set once by: node scripts\setup.mjs
cd /d "%~dp0..\server"
node server.mjs
