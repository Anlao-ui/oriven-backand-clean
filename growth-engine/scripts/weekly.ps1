# Called by Windows Task Scheduler every Sunday evening.
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force data\logs | Out-Null
$log = "data\logs\weekly_$(Get-Date -Format yyyy-MM-dd).log"
& .\.venv\Scripts\python.exe -m growth_engine weekly *>&1 | Tee-Object -FilePath $log
