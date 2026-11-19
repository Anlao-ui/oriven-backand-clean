# Registers the weekly job: every Sunday 19:00, only when on AC power is not required.
$root = Split-Path $PSScriptRoot -Parent
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\weekly.ps1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 19:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName "OrivenAI Growth Engine (weekly)" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Leads, concepten en content voor volgende week" -Force | Out-Null
Write-Host "Taak 'OrivenAI Growth Engine (weekly)' staat op zondag 19:00."

# Weekdays 09:12: send approved mails within the daily cap, read replies, publish approved posts.
$action2 = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\daily_send.ps1`"" -WorkingDirectory $root
$trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 09:12
Register-ScheduledTask -TaskName "OrivenAI Growth Engine (daily send)" -Action $action2 -Trigger $trigger2 `
  -Settings $settings -Description "Alleen goedgekeurde mails/posts" -Force | Out-Null
Write-Host "Taak 'OrivenAI Growth Engine (daily send)' staat op werkdagen 09:12."
