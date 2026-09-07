# Gateway threat model

**Scope:** Self-hosted exact-payment V1 and the static public Playground demo.
The controls below reduce risk; they do not establish full security or replace
external review.

| Threat | Current control | Test/evidence | Residual risk |
|---|---|---|---|
| SSRF/private network | HTTPS default; hostname and resolved-address denial; exact dev allowlist | Private DNS unit test | DNS can change between check and socket connect; require production egress proxy/firewall |
| Loopback/link-local/metadata | Literal and resolved reserved ranges rejected | Config/DNS tests | New special ranges require maintenance |
| Header injection | Allow safe headers; strip auth, proxy, forwarded, cookie, payment, host, hop-by-hop | Proxy preservation test | Application-specific sensitive headers require deployment policy |
| Request smuggling | Reject conflicting length/transfer framing; Node Fetch owns encoding | Framing/body tests | Front proxy/parser disagreement needs deployment testing |
| Large request/response | Declared and streamed byte ceilings | Bounded-reader tests | Buffering within configured ceiling consumes memory |
| Redirect abuse | Fetch redirect policy is `error` | Proxy configuration test | Upstream can return URLs in bodies; bodies remain untrusted |
| Payment replay/double settlement | Payment-derived ID; durable settlement lookup; in-flight coalescing | Replay test calls settle once | JSONL is single-host, not multi-instance atomic storage |
| Upstream retry duplication | Stable `Idempotency-Key` from payment ID | Replay test checks stable key | Upstream must honor idempotency; unsafe methods can still duplicate work |
| Settlement then upstream failure | Error includes canonical payment response and transaction; outcome records provider fault | Failure-after-settlement test | No automatic refund; seller dispute/refund process is future work |
| Upstream impersonation | HTTPS and platform TLS verification | HTTPS config validation | No certificate pinning; DNS/CA compromise remains |
| Catalog poisoning | Existing settlement, payee, live-terms, schema, and ownership admission | Bazaar tests | Seller descriptions and response schemas remain untrusted |
| Malicious upstream response | Response byte limit and safe response-header allowlist | Proxy tests | Paid body can contain malicious content; consumers must sandbox/render safely |
| DoS | Request rate, concurrency, time, and byte limits | Focused gateway tests | In-memory counters are per process and client IP depends on trusted edge |
| Gateway takeover | Config file mode, non-root container, optional management bearer token | Image build and auth test | Token has no rotation/audit service; managed auth is future work |
| Developer authorization | No public management API; future boundary uses existing project/session identity | Portal boundary review | Self-hosted operators control local config |
| Temporary gateway abuse | Public Playground has no creation endpoint and one static allowlisted upstream | Playground config/build | Managed temporary gateways, TTL cleanup, and quotas are not implemented |
| Secret leakage | No payer key, signature, or body in events; stripped upstream auth | Event/proxy review | Operator logs and external proxies require separate review |

Before production: add network-enforced egress controls, multi-instance atomic
idempotency, authenticated project ownership, distributed rate limits, secret
rotation, audit logging, security testing, and an independent review.