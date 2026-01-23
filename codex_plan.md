# Analysis
- Status now transitions to "aborted", but the Codex child can keep running/outputting, so the UI still shows tool events after abort.
- The stdout/stderr readers keep streaming even after abort; the read loop can continue emitting events despite finalized status.
- If the child process does not exit, the read loop waits on exitPromise and never stops logging.

# Fix plan
1) Add a small I/O cleanup helper and close/destroy stdio when abort is requested.
2) Stop ingesting Codex output once a run is finished or aborted, and avoid waiting on exitPromise after abort.
3) Verify abort produces no additional tool events after status is "aborted".
