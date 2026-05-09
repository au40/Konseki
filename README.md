Immersion tracker that lets you grab GSM and ttsureader stats and aggregate them into one place.

Features:  
Automatic stat pull from GSM and ttsureader, hands off  
Video semiautomatic tracking  
Manual log entry  
Goal setting  
7 Day rolling backups  

If you want just the logger + automatic GSM logs, you can just use the exe. If you want ttsureader automatic imports and video tracking, you'll need the browser extension as well.  

Requires:  
Windows 10/11  
Python  

pip install -r requirements.txt

Intended to be an always open application in your tray, monitoring your GSM files for changes and automatically updating your tracker with the session log from GSM. Aggregates all stats GSM will give you. Can opt out of automatic logging and have it pull GSM stats only when you click a button instead.
