# GPU environment for the QLoRA fine-tune (separate venv so the main app stays light).
#   powershell -ExecutionPolicy Bypass -File scripts\setup_gpu.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py -3" } else { "python" }
if (-not (Test-Path ".venv-gpu")) { Invoke-Expression "$py -m venv .venv-gpu" }
$p = ".\.venv-gpu\Scripts\python.exe"
& $p -m pip install --upgrade pip
& $p -m pip install torch --index-url https://download.pytorch.org/whl/cu121
& $p -m pip install -r requirements-gpu.txt
# Unsloth is optional (faster, less VRAM). If it fails on your setup, PEFT is used instead.
try { & $p -m pip install unsloth } catch { Write-Host "Unsloth niet geinstalleerd, PEFT wordt gebruikt." }
& $p -c "import torch; print('CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
