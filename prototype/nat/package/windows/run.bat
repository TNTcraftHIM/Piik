@echo off
rem Runs piik-nat-lab beside this file, shows its report and keeps a copy in report.txt.
chcp 65001 >nul
cd /d "%~dp0"
echo 正在测试，一般十几秒，网络不通时最多一两分钟，请稍候……
piik-nat-lab.exe > report.txt 2>&1
type report.txt
echo.
echo 报告已保存在本文件夹的 report.txt，把这个文件发回即可。
pause
