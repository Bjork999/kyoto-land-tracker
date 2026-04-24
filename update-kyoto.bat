@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  京都土地一覧 更新スクリプト
echo ============================================
echo.

if not exist node_modules (
  echo [0/3] 初回セットアップ: 依存パッケージをインストール中 ^(2-3分^)...
  call npm install
  if errorlevel 1 goto :err
  echo.
)

echo [1/3] 3サイトからスクレイプ中 ^(5-10分^)...
call npm run scrape
if errorlevel 1 goto :err

echo.
echo [2/3] Gist にアップロード中...
call gh gist edit 02bb787a1f2ffa72ce6f1bffbe91f3aa --filename kyoto_land_list.html index.html
if errorlevel 1 goto :err

echo.
echo [3/3] 完了!
echo.
echo   閲覧 URL ^(スマホで開く^):
echo   https://htmlpreview.github.io/?https://gist.githubusercontent.com/Bjork999/02bb787a1f2ffa72ce6f1bffbe91f3aa/raw/kyoto_land_list.html
echo.
echo   ^(またはプレビューなしで直接: https://gist.github.com/Bjork999/02bb787a1f2ffa72ce6f1bffbe91f3aa^)
echo.
pause
exit /b 0

:err
echo.
echo !!!!!! エラーが発生しました !!!!!!
pause
exit /b 1
