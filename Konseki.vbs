' Konseki launcher — starts the tracker with no console window.
' Runs pythonw against the source in THIS folder, so it always uses your
' latest code (edit db.py / ui.js / etc., relaunch, done — no rebuild).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
shell.Run "pythonw.exe " & Chr(34) & "tracker.py" & Chr(34), 0, False
