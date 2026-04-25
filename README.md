Immersion tracker that lets you grab GSM and ttsureader stats and aggregate them into one place.

Log function to use as main immersion tracker, like polylogger/toggl/refold.

Requires:  
Windows 10/11  
Python  

pip install -r requirements.txt

Intended to be an always open application in your tray, monitoring your GSM files for changes and automatically updating your tracker with the session log from GSM. Aggregates all stats GSM will give you. Can opt out of automatic logging and have it pull GSM stats only when you click a button instead.

For ttsureader to be entirely automatic it would require a script or browser addon and be a little too invasive. For ttsu, you hit the export button and drag/drop into the ttsu pane on the bottom left.
