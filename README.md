Immersion tracker that lets you grab GSM and ttsureader stats and aggregate them into one place.

Log function to use as main immersion tracker, like polylogger/toggl/refold.

Requires:  
Windows 10/11  
Python  

pip install -r requirements.txt

Intended to be an always open application in your tray, monitoring your GSM files for changes and automatically updating your tracker with the session log from GSM. Aggregates all stats GSM will give you. Can opt out of automatic logging and have it pull GSM stats only when you click a button instead.

For ttsureader, I have an optional extension in the works that will just read your stats at the end of a ttsureader session. Likely can also do mokuro reader like that. As of now, its just a zip drag+drop.
