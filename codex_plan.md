Analysis
- codexDeleteMcpTask lives in plugin/backend/index.mjs and currently rejects running tasks; it only removes queued requests from requestsFile and has no abort attempt.
- mcp-tasks.mjs records startedAt for running tasks but has no timeout checks; queued tasks can linger indefinitely.
- syncRequests/startRun do not enforce timeouts; a hung run keeps window/task status running and the queued request list can accumulate.

Plan
1) Add timeout utilities in plugin/backend/lib/mcp-tasks.mjs (constants + checkTaskTimeouts) and enhance running/queued task bookkeeping.
2) Update plugin/backend/index.mjs to:
   - allow deletion of running tasks with optional force, attempt abort, and log.
   - call checkTaskTimeouts before processing requests and prune timed-out queued requests.
   - add run timeout handling in startRun and a periodic monitor to clean stuck tasks/runs.
3) Validate via npm run validate.
