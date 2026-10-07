# Stable remote long-history loading

The user authorized optimization after repeated bar disconnections during history reads. The installed runtime is the baseline. A synthetic 28.5 MB history response reproducibly fails inside the proxy's 16 MiB receiver with WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, closing the desktop with code 1006 while the gateway survives. Actual bar logs conceal whether each incident was that limit or buffered output pressure; both must stop turning an oversized RPC into a broken connection.

## History reads

Honor `itemsView: notLoaded` by returning turn metadata with empty items. Keep full item content available through existing item pagination and full views. Use lazy page presentation: only clone/format values selected for the requested page. Bound pages to an 8 MiB target; one indivisible entry may exceed that target and must be returned alone, subject to the 64 MiB RPC response ceiling. Keep anchor cursors correct in both directions, with no omissions, duplicates, or empty progress pages. Do not truncate persisted or returned content silently.

Refresh managed native history on explicit thread read/resume and before the first page in a new runtime. Subsequent pages reuse the synchronized store, which native notifications update, rather than fetching and cloning the entire native transcript on every page. Preserve hydration race protection, history edits, and mutation serialization.

## Transport

Keep inbound desktop requests limited to 16 MiB. Permit the proxy to receive bounded legacy gateway responses up to 128 MiB so an active older gateway can remain running. Outgoing RPC responses are limited to 64 MiB: replace an oversized response with a small explicit error for that same ID, keep the connection alive, and never replay the operation. The error must preserve uncertain mutation outcomes and use the existing `decoded message length too large` marker where applicable.

Cap forwarded read-only pagination request counts to 20 turns / 100 items for compatibility with active older gateways; their returned opaque cursors stay authoritative. Avoid closing a connection merely because one RPC response would exceed the output buffer budget: reject that response with an explicit transient error while retaining the controller. Keep a finite bound for genuinely unresponsive peers and preserve existing heartbeat and approval semantics. Log concise direction, error code, payload size/limit, and method where known, without transcript bodies or credentials.

## Deployment and validation

The running bar research gateway and its task must survive. Deploy a new digest-addressed archive, never modify files inside a published runtime directory. Replace the desktop package from the installed baseline with reviewed files only, preserving unrelated work and a full rollback copy. Reconnect only bar's transient proxy to the new runtime; an active gateway may defer its own upgrade. Prefer a targeted transport reconnection over restarting a desktop with active local tasks. Report precisely which components are upgraded/deferred.

Tests must reproduce a large response over actual WebSockets, show connection survival after an oversized response error and a subsequent healthy RPC, cover correct byte-bounded pagination and notLoaded metadata, and show that repeated pages do not refetch native history. Run existing remote, router, history, and event regressions. Verify bar against its actual large history with read-only calls and desktop logs, while preserving active task identity/processes.
