# Change Logs

## master

 - bug fix:
   - skip sessions without a transcript in snapshots and restore
   - don't open `claude agents` for a once-background session that is no longer one
 - tweaks:
   - rename project to `claude-session-manager` ( the command stays `ccs` )
 - features:
   - add `NAME` column ( `-c6` ) showing the `/rename` title, included by default
   - add snapshots: `ccs snap`, `ccs snaps`, `ccs restore`, and `ccs snap install` for 5-minute auto snapshots
