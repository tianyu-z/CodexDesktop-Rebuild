# blc-2 login hostname unavailable

Status: diagnosed at the SSH/DNS boundary; connection is not restored. Checks
were performed on October 9, 2026, 17:49–17:54 America/Los_Angeles
(October 10, 00:49–00:54 UTC).

## Verified failure

The affected project is `agentrl_scaffold` on SSH alias `blc-2`, with saved path
`/lustre01/tenant1/home_blc2/tianyu.zhang/code/agentrl_scaffold`.
The screenshot's `Remote engine setup failed (255)` wraps this SSH error:

```text
ssh: Could not resolve hostname slurm-gb300-shared-dev-group:
nodename nor servname provided, or not known
```

A direct `ssh -o BatchMode=yes -o ConnectTimeout=10 blc-2 ...` reproduces exit
255 before connecting or authenticating. Both desktop processes independently
report the same DNS failure: dev PID 4323 at 00:54:06.572 UTC and official PID
4333 at 00:54:03.920 UTC. Available October 9 logs already show this error at
23:57:04.779 UTC (16:57 local). This is the first observed occurrence in those
logs, not proof of the infrastructure incident's start time.

## Configuration and DNS evidence

`~/.ssh/config` has two `Host blc-2` blocks, at lines 69 and 72. The first sets
`HostName slurm-gb300-shared-dev-group`; the second sets
`HostName slurm-gb300-blc-login-tianyu-zhang`. OpenSSH uses the first obtained
HostName, as confirmed by `ssh -G blc-2`. There is no ProxyJump or ProxyCommand.
The duplicate blocks do not provide failover.

Both configured names fail system resolution, including their fully qualified
`.cheetah-koi.ts.net` forms. Direct DNS queries to Tailscale's `100.100.100.100`
return NXDOMAIN for the shared name and its fully qualified form. The latter is
an authoritative negative answer from the tailnet zone. Overriding HostName
with the already-configured personal name also fails, so reordering the two
blocks would not restore connectivity.

Local Tailscale is Running, online, with no reported health errors and DNS
enabled. The working `blc-login-0` resolves and accepts SSH. That remote host
also fails to resolve both BLC-2 login names. The local Tailscale network map
contains no matching peer or extra DNS record for either name. These findings
exclude a chatgpt-dev-only transport problem and a local negative DNS cache as
the explanation for this incident. They do not establish whether the missing
node was removed, renamed, or became unavailable through a network policy
change.

## Recovery paths checked

The network map still has a `blc2-gateway.cheetah-koi.ts.net` extra DNS record,
but a TCP connection to its SSH port times out. The two named BLC-2 Slurm
gateway ingress peers are reported offline, last seen at 17:01:28–32 UTC on
October 9. These are additional observations, not proof that their downtime
caused the missing login-node record. No replacement login host identity has
been established, and no existing local SSH connection to the original login
node was found. `kubectl` and a local kubeconfig were not available; the working
`blc` login also has no `kubectl` available in its command path.

## Required next step

Restore the original BLC-2 login endpoint in the cluster/network, or obtain its
current supported SSH destination. The user has been asked whether there is a
maintenance/migration notice or a new login address. Once a destination is
available, verify its identity, expected project path and existing chat storage
before changing the SSH alias, then verify actual dev reconnection.

No app/runtime code, SSH configuration, DNS settings, remote jobs, chat messages,
or services were changed during this diagnosis. Restarting dev or clearing DNS
cannot recreate a missing upstream login endpoint.
