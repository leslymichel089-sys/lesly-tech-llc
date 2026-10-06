@echo off
REM Lanceur du site vitrine Lesly Tech LLC (Windows)
REM Double-cliquez sur ce fichier pour demarrer le site.
title Lesly Tech LLC — Site officiel
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERREUR] Node.js n'est pas installe.
  echo Telechargez-le ici : https://nodejs.org/
  echo Puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installation des dependances (premiere fois seulement)...
  call npm install
  echo.
)

echo.
echo ================================================
echo  Lesly Tech LLC — site officiel
echo  Adresse du site : http://localhost:3000
echo  Admin           : http://localhost:3000/admin
echo  (laissez cette fenetre ouverte)
echo ================================================
echo.
call npm start
pause
