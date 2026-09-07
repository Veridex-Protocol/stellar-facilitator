# Gateway security

The gateway is a constrained payment edge, not an arbitrary proxy.

Default controls:

- HTTPS-only upstreams; local HTTP requires an explicit development flag and
  exact origin allowlist.
- Literal and DNS-resolved loopback, private, link-local, reserved, `.local`,
  and `.internal` destinations are rejected.
- Redirects use `redirect: "error"`.
- Route map, methods, concurrency, request rate, timeout, request bytes, and
  response bytes are bounded.
- Authorization, proxy, host, forwarded, cookie, payment, and hop-by-hop
  headers are not forwarded.
- Conflicting transfer framing is rejected before settlement.
- Payment payload hash is the settlement and upstream idempotency key.
- Event and provider records omit payment signatures, private keys, and bodies.

DNS is checked during startup and again before every upstream request. This
reduces rebinding exposure but cannot pin a Node HTTP connection to a verified
address; production deployments still need an egress proxy/firewall with DNS
pinning and private-network denial.

Public Playground configuration is static and allowlisted. It does not expose
an unauthenticated gateway-creation endpoint. Temporary managed gateways,
cleanup jobs, and per-developer creation quotas are future platform work.

See the detailed [gateway threat model](security/gateway-threat-model.md).