@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Nernier - mise en ligne sur Netlify
echo.
echo  Nernier - Suivi projet : mise en ligne sur Netlify
echo  ---------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :nonode
echo.
echo  [1/3] Preparation des fichiers...
call npm install --no-audit --no-fund
if errorlevel 1 goto :err
echo.
echo  [2/3] Connexion a ton compte Netlify.
echo        Si une page s'ouvre dans le navigateur, clique sur "Authorize".
call npx -y netlify-cli@27.12.0 login
if errorlevel 1 goto :err
echo.
echo  [3/3] Mise en ligne...
echo        La premiere fois, choisis "Create & configure a new project",
echo        puis ton equipe, puis le nom du projet (par exemple nernier-suivi).
call npx -y netlify-cli@27.12.0 deploy --prod
if errorlevel 1 goto :err
echo.
echo  Termine. L'adresse du site est indiquee ci-dessus.
echo.
pause
exit /b 0

:nonode
echo.
echo  Node.js n'est pas installe sur cet ordinateur.
echo  Installe la version LTS depuis https://nodejs.org puis relance ce fichier.
echo.
pause
exit /b 1

:err
echo.
echo  Une erreur est survenue. Fais une capture de cette fenetre et envoie-la a Claude.
echo.
pause
exit /b 1
