# One-time setup on Windows. Run from the project folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "== Python ==" -ForegroundColor Yellow
if (-not (Have "py") -and -not (Have "python")) { winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements }
$py = if (Have "py") { "py -3" } else { "python" }
if (-not (Test-Path ".venv")) { Invoke-Expression "$py -m venv .venv" }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe -m playwright install chromium

Write-Host "== ffmpeg ==" -ForegroundColor Yellow
if (-not (Have "ffmpeg")) { winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements }

Write-Host "== Ollama + basismodel ==" -ForegroundColor Yellow
if (-not (Have "ollama")) {
  winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
  $env:Path += ";$env:LOCALAPPDATA\Programs\Ollama"
}
# Pick the base model by GPU memory: 7B with >= 8 GB VRAM, else 3B (both run fine on CPU too, just slower).
$vram = 0
if (Have "nvidia-smi") { $vram = [int]((nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits) | Select-Object -First 1) }
$model = if ($vram -ge 7500) { "qwen2.5:7b-instruct" } else { "qwen2.5:3b-instruct" }
Write-Host "GPU-geheugen: $vram MB -> $model"
ollama pull $model
$cfg = Get-Content config.json -Raw | ConvertFrom-Json
$cfg.llm.base_model = $model
$cfg | ConvertTo-Json -Depth 10 | Set-Content config.json -Encoding UTF8

if (-not (Test-Path ".env")) { Copy-Item .env.example .env; Write-Host ".env aangemaakt: vul je Zoho app-wachtwoord in." }

Write-Host "== Tests ==" -ForegroundColor Yellow
& .\.venv\Scripts\python.exe -m pytest -q

Write-Host "== Wekelijkse taak (zondag 19:00) ==" -ForegroundColor Yellow
& powershell -ExecutionPolicy Bypass -File scripts\register_task.ps1

Write-Host "Klaar. Dashboard: .\.venv\Scripts\python.exe -m growth_engine dashboard" -ForegroundColor Green
