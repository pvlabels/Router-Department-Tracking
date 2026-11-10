@echo off
rem Laser Run Logger panel — one-time install for Adobe Illustrator (Windows).
rem The extension is signed, so this just copies it into the user's CEP
rem extensions folder. No admin rights or registry changes needed.

set "DEST=%APPDATA%\Adobe\CEP\extensions\com.pvlabels.laserlogger"

echo Installing Laser Run Logger panel...
if exist "%DEST%" rmdir /S /Q "%DEST%"
xcopy /E /I /Y "%~dp0com.pvlabels.laserlogger" "%DEST%" >nul
if errorlevel 1 (
  echo.
  echo ERROR: could not copy files. Try running this again.
  pause
  exit /b 1
)

echo.
echo Done! Restart Illustrator, then open the panel from:
echo    Window ^> Extensions ^> Laser Run Logger
echo.
echo Dock it anywhere and it will be there every time Illustrator opens.
pause
