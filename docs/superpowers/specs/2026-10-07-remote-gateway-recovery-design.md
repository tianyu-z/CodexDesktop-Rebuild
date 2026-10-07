# Remote gateway recovery

The approved repair restores chatgpt-dev remote connectivity without resuming conflicting research work or disrupting the official app. The installed runtime is the baseline; unrelated working-tree changes must remain untouched.

## Transport
The stdio WebSocket proxy must verify the downstream desktop with ping/pong, not rely on the upstream gateway pinging the proxy. Send a ping every 30 seconds; a missing matching pong by the next interval closes both proxy WebSockets and stdio. A live idle desktop remains connected. Close clears the timer; no timers or pending request closures remain after disconnect. Single-controller exclusion remains in place for live peers.

## Bounded native requests
NativeClient must reject and remove unanswered RPCs within a finite default deadline (30 seconds). Allow constructor-level deadline injection for deterministic tests. Clear deadlines on result, error, transport failure, and shutdown. Ignore late replies after expiry. Never retry or replay requests, especially mutations. A timeout must explain that the native backend did not respond; it must not claim cancellation or success. This releases the gateway in-flight slot through its existing finally block.

## Operational recovery
The sko native PID 303041 is a duplicate execution of chat 01a0f78f-3d01-73f3-b98b-efa11c796128 (评估顶会投稿成熟度). The official backend currently owns the intended ongoing run. Retire the stopped development backend, without resuming its duplicate turn or touching Slurm jobs. Preserve its history and the official backend. Install a new content-addressed remote runtime and recreate only idle or specifically verified conflicting development gateways. Do not mutate an existing hash-addressed runtime. Preserve live unrelated remote work; defer upgrades there.

## Deployment
Build from the existing installed archive with only reviewed repair files replaced. Save a small backup of replaced files and manifest, update the installed runtime archive/manifest, re-sign and verify the app. Deploy by SSH with verified SHA-256 and private directories. Validate sko, blc, blc-2 reconnection in the actual desktop logs, including post-initialize authentication.

## Validation
A desktop that ignores ping must lose proxy ownership within two test intervals; a new client must initialize against the same still-running gateway. Responsive idle clients must survive multiple intervals. Native requests that never reply must reject, late replies must not corrupt later calls, and repeated timeouts must not accumulate pending entries. Existing approval replay, second-controller exclusion, agent-map fallback, daemon upgrade, and native close behavior must remain passing.
