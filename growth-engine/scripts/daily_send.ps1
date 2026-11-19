# Optional: send approved mails (within the daily cap) and read replies. Register it daily if you like.
Set-Location (Split-Path $PSScriptRoot -Parent)
& .\.venv\Scripts\python.exe -m growth_engine send
& .\.venv\Scripts\python.exe -m growth_engine content publish
