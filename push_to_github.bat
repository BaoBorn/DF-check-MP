@echo off
:: Chuyển về thư mục chứa file script này
cd /d "%~dp0"

set "GIT_PATH=C:\Program Files\Git\bin\git.exe"
if not exist "%GIT_PATH%" set "GIT_PATH=git"

echo Checking Git...
"%GIT_PATH%" --version
if errorlevel 1 (
    echo [ERROR] Git not found. Please install Git from https://git-scm.com/
    pause
    exit /b
)

echo Configuring Safe Directory...
"%GIT_PATH%" config --global --add safe.directory "%CD:\=/%"

echo Configuring Author Identity...
"%GIT_PATH%" config user.email "bao@born.com"
"%GIT_PATH%" config user.name "BaoBorn"

echo Initializing Repository...
if not exist .git (
    "%GIT_PATH%" init
)
"%GIT_PATH%" add .
"%GIT_PATH%" commit -m "Cập nhật logic check ammo và quy đổi stack"
"%GIT_PATH%" branch -M main

echo Setting Remote...
"%GIT_PATH%" remote remove origin >nul 2>&1
"%GIT_PATH%" remote add origin https://github.com/BaoBorn/DF-check-MP.git

echo Pushing to GitHub...
"%GIT_PATH%" push -u origin main --force

echo Done!
pause
