The Windows release build places `rippel-tray.exe` here (built by the
`tray` GitHub workflow from `apps/tray`) before compiling, and the agent embeds
it. Without it, the agent falls back to the PowerShell tray in `tray.ps1`.
