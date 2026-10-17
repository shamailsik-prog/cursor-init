# F25: one fetch boundary for every corpus source (design)

**Finding.** Audit F25 (HIGH, P0), `docs/audit/2026-10-13-forensic-audit.md:567`: "Nasir source links can drive unrestricted HTTP requests." Every absolute http link on a Nasir reporter page whose href contains `case` or `.htm` is fetched with no host, IP, port or redirect control (`corpus_service/scraper/tasks/nasirlawsite.py:36-41` on main 1f0cc27). The source HTML is external input, not configuration. The other connectors' host checks do not protect this path. Recommended correction: route all fetches through one HTTPS allowlist client; validate the hostname, the resolved public IPs, the port, each redirect and the final origin; block private and link-local destinations; enforce network egress restrictions.

**Rule for closure** (`docs/audit/REMEDIATION.md`): a merged PR with an end-to-end test of the real flow that fails on main and passes after, then an independent re-audit.

## 1. What main does today (every outbound path in `corpus_service/`)

| Path | Who picks the URL | Host control | Redirects | IP / DNS control |
|---|---|---|---|---|
| `scraper/tasks/nasirlawsite.py:31-41` | the reporter page (any `href` with `case` or `.htm`; absolute links taken as is) | none | not followed (httpx default) | none |
| `scraper/tasks/nationalassembly.py:9-19` | the NA index page (any `.pdf` link whose text says Act/Ordinance; absolute links taken as is) | none | not followed | none |
| `scraper/tasks/pakistancode.py:9-18` | fixed URLs in code | n/a | not followed | none |
| `scraper/tasks/shc.py:132, 184` | listing pages and inline scripts | `host.endswith("sindhhighcourt.gov.pk")` or `endswith("shc.gov.pk")` (no dot anchor), http allowed | **followed** (`follow_redirects=True`) to any host | none |
| `scraper/tasks/supremecourt.py:366, 420` | listing pages, sitemap text | `endswith("supremecourt.gov.pk")`, http allowed | **followed** | none |
| `scraper/tasks/lahorehighcourt.py:101, 155` | listing pages, inline text | `endswith("lhc.gov.pk")`, http allowed | discovery **followed**; PDFs not | none |
| `scraper/tasks/peshawarhighcourt.py:183, 241` | listing pages | exact host set, http allowed, any port | **followed** | none |
| `scraper/tasks/balochistanhighcourt.py` (same shape) | listing pages, `data-*` attributes | exact host set, any port | **followed** | none |
| `scraper/tasks/islamabadhighcourt.py:456, 544` | listing pages, AJAX feed JSON (`ATTACHMENTS`) | exact host set, any port | **followed** (GET and POST) | none |
| `bootstrap_harvest.py:83` (operator script) | PakistanCode detail pages (PDF links, any host), NA index (PDF links, any host), Nasir pages (host-checked), `robots.txt` of **any** URL's origin before the URL is checked | partial | **followed** | none |
| `scraper/parsers/pdf_extractor.py:308, 466` (no callers) | caller | none | **forced on** per request; `download_pdf_sync` builds its own client | none |

So the Nasir path is the worst, but it is not the only open one: every court connector follows redirects off its allowlist, none checks resolved addresses (a court subdomain that resolves to 10.x, 169.254.169.254 or 127.0.0.1 is fetched), several accept any port and plain http, and the suffix checks accept look-alike registrations such as `evillhc.gov.pk`. `trust_env` is on everywhere, so `HTTP(S)_PROXY` and `~/.netrc` from the environment also apply.

## 2. Rulings

Each ruling records the decision and the reason (owner's standing instruction).

**R1. One module, `corpus_service/scraper/net/fetch_policy.py`, owns every outbound HTTP request a corpus source makes.** Connectors and `bootstrap_harvest.py` get a client from `fetch_policy.fetcher_for(<policy>)` (async) or `fetch_policy.sync_fetcher_for(<policy>)` (sync). Nothing else in `corpus_service/` may build an HTTP client. *Reason:* the finding asks for one client; a per-connector check is what failed (the court checks do not protect Nasir, and even the court checks leak through redirects).

**R2. Enforcement is layered, so a mistake in one layer is caught by the next.**
1. `PolicyFetcher.get/post` validates the URL before sending and logs and raises `FetchRefused` on refusal.
2. The client's transport (`_GuardedTransport`, a subclass of `httpx.AsyncHTTPTransport`) re-validates **every request URL that reaches the wire**, including each redirect hop. Any use of the client is checked, not only the `get` helper.
3. The transport's connection pool uses `_GuardedBackend`, an `httpcore.AsyncNetworkBackend` that resolves the hostname itself, refuses unless **every** resolved address is public, and then connects to the vetted **IP address**, never to the hostname. TLS still verifies the certificate and SNI against the hostname (httpcore passes the URL host to `start_tls`).

*Reason:* the connect-time check is what defeats DNS rebinding. There is no window between "resolve and check" and "resolve and connect": the address that was checked is the address the socket connects to. Validating in the transport means `follow_redirects`, a helper such as `download_pdf`, or a future caller cannot skip the URL policy.

**R3. HTTPS only.** No configured source needs plain http: every seed URL in the connectors and every `scraper_sources.source_url` seed in `scraper/database.py` is https. A plain-http link is refused and logged, and an https→http redirect is refused as `scheme_downgrade`. *Reason:* the brief allows http only where a source genuinely needs it; none does. *Cost:* a court page that links a document by an `http://` URL is no longer fetched (residual 3).

**R4. Per-source host allowlists live in code (`SOURCE_POLICIES`), never in page content or the database.** Each policy is a set of exact hostnames plus optional dot-anchored suffixes (`.lhc.gov.pk` matches `sys.lhc.gov.pk`, never `evillhc.gov.pk`). The court sets keep each connector's existing scope (Peshawar, Balochistan and Islamabad: their exact sets; Lahore, Supreme Court, Sindh: the registered domain and its subdomains). A test ties the registry to the source registry: every seeded `source_url` of every routed source, and every seed URL in each connector, must pass its connector's policy. *Reason:* `scraper_sources.source_url` is editable data; the allowlist is reviewed configuration. Keeping each court's current scope avoids silently dropping coverage, while the dot anchor closes look-alike registrations.

**R5. URL rules (all must hold).**
- The URL parses with httpx (the same parser that sends it), and `urllib.parse` reads the same host. Any disagreement is `ambiguous_url`. This blocks parser-differential tricks such as `https://allowed\@evil/`.
- The scheme is `https`.
- There is no userinfo, and no `@` anywhere in the authority, so `https://user:pw@host/` and `https://allowed@evil/` are refused.
- The host is ASCII letters, digits, hyphens and dots only. That excludes `%`, `_` and a trailing dot.
- The host has no `xn--` label. IDN and punycode hosts are refused outright, so a homoglyph of an allowlisted name can never match.
- The host is not an IP literal in any form the resolver would accept: dotted, decimal (`2130706433`), hex (`0x7f.0.0.1`), octal, short (`127.1`), or bracketed IPv6. The check is `ipaddress` plus `socket.inet_aton`.
- The host is allowlisted, and the effective port (443 when absent) is in the policy's port set ({443} for every production policy).
- The fragment is dropped.

**R6. Address rules.** An address is allowed only if Python's `is_global` is true **and** it lies outside an explicit block list, and, for IPv6, inside `2000::/3`. The block list does not depend on the Python patch version:
- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT, which includes Alibaba's 100.100.100.200), `127/8`, `169.254/16` (link-local, which includes 169.254.169.254 and 169.254.170.2), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`.
- IPv6: `::/8` (unspecified, loopback, IPv4-mapped `::ffff:0:0/96`, IPv4-compatible), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), `100::/64`, `2001::/23` (Teredo and other IETF assignments), `2001:db8::/32`, `2002::/16` (6to4), `3fff::/20`, `5f00::/16`, `fc00::/7` (ULA, which includes AWS `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`.

If **any** resolved address is blocked, the whole hostname is refused (fail closed: a name that mixes public and private records is suspect). Unix sockets are refused.

*Reason:* the finding names private, link-local and metadata destinations. IPv4-mapped, 6to4, Teredo and NAT64 can each smuggle an IPv4 target, so they are refused outright rather than decoded. **Ruling R6a:** NAT64/DNS64 networks are not a deployment target, so failing closed there is acceptable (residual 4).

**R7. Redirects are never automatic.** The client runs with `follow_redirects=False`. `get` follows at most 5 hops itself, re-validating each `Location` (joined to the current URL) through R5 before sending; the transport and backend re-check each hop again. After the body is read, the final URL is validated once more (the final-origin check). A POST is never redirected: the IHC feed is the only POST, and a 3xx is returned to the caller as is. *Reason:* the finding asks for each redirect and the final origin to be validated. A POST replayed to a new origin is exactly the request smuggling we want to avoid.

**R8. Bounded everything.**
- Timeouts: connect 10 s, read 60 s, write 30 s, pool 10 s, as `httpx.Timeout`.
- An overall per-fetch deadline of 300 s covers the redirects and the body. A server that drip-feeds bytes cannot hold a worker forever, because the read timeout alone resets on every chunk.
- Bodies are capped at 100 MiB, counted after content decoding (gzip bombs count by output). That matches `pdf_extractor.MAX_PDF_SIZE_BYTES`.
- Over-limit and deadline both raise `FetchRefused` (`too_large`, `deadline_exceeded`).

*Reason:* the audit's P0 fetch-security test row (`:1102`) asks to "cap bytes and elapsed time". Parser isolation and the PDF-specific limits remain **F26**.

**R9. The environment is ignored.** `trust_env=False`, so there are no env proxies, no `~/.netrc` credentials and no `SSL_CERT_FILE` overrides. Certificates are verified against certifi, and HTTP/2 is off. *Reason:* a proxy would make the address check meaningless (the socket would go to the proxy), and `.netrc` would attach credentials to whatever host a page names. An operator who needs an egress proxy gets it through follow-up F25-FU1, not through ambient env vars.

**R10. A refused link is skipped and logged, never fetched.**
- The log line is one WARNING: `F25 fetch boundary refused <url> (<reason>) under policy <name>`. Any userinfo is redacted to `***@` so a page cannot get a credential written into the logs.
- Connectors already catch per-URL errors and continue. The court retry helpers do not retry a refusal.
- Nasir pre-filters links with `fetcher.allows(url)`, so a refused link costs no request and no retry.

**R11. Test-only hooks are explicit constructor arguments only, and production refuses them.** `PolicyFetcher(policy, _test_ssl_context=..., _test_loopback_origins={(host, port)}, _test_resolver=...)`:
- `_test_loopback_origins` lets a **loopback** address (only loopback, nothing else private) through for that exact (host, port). Its only use is a source server on 127.0.0.1 in a test.
- `_test_ssl_context` trusts the test CA.
- `_test_resolver` injects DNS answers. It cannot bypass the address check, which still applies to whatever it returns.

Production cannot reach these hooks:
- There is no env var or setting that turns them on. The production factories `fetcher_for` and `sync_fetcher_for` accept none of them.
- The constructor raises `RuntimeError` if any is passed while `ENVIRONMENT` is not `development`. The default is `production`, as in `Settings`. The env var can only refuse a hook, never enable one.
- The guard test (R12) fails if any non-test module passes a `_test_*` keyword.

**R12. The guard test closes the class.** An AST scan of every non-test module in `corpus_service/` except `fetch_policy.py` fails on:
- constructing `httpx.Client`, `AsyncClient`, `HTTPTransport` or `AsyncHTTPTransport`, or any httpcore pool;
- calling module-level `httpx.get/post/put/patch/delete/head/options/request/stream`;
- importing `requests`, `aiohttp`, `urllib.request`, `urllib3`, `http.client`, `httplib2`, `pycurl` or `playwright`;
- calling `socket.socket`, `socket.create_connection` or `asyncio.open_connection`;
- any `follow_redirects=True` keyword;
- any `_test_*` keyword.

Positive controls prove the scanner catches each form. A second check requires every harvester routed by `dispatcher.ROUTES` that fetches (all except PakistanLawSite, which reads an import folder) to call `fetch_policy.fetcher_for` with a registered policy name. *Reason:* the brief's closure proof. It also stops the next connector from reopening the hole.

**R13. Adoption: all ten fetch paths, not only Nasir.**
- Every connector: nasirlawsite, nationalassembly, pakistancode, shc, supremecourt, lahorehighcourt, peshawarhighcourt, balochistanhighcourt and islamabadhighcourt.
- `bootstrap_harvest.py`: its `robots.txt` lookup goes through the same per-source client, after the policy check.
- `pdf_extractor.download_pdf` no longer forces redirects on, and `download_pdf_sync` no longer builds its own client. Both are unused; F26 will route PDFs.

Connector discovery filters stay as they are. They are heuristics; the boundary is the fetcher. Nasir now resolves relative links against the page it actually fetched (`urljoin`). For the real reporter URLs that gives the same result as main's hard-coded prefix, and it stops `//host/x` from being glued onto the Nasir host. *Reason:* routing only Nasir would leave the redirect, IP and port holes in nine other paths. The per-connector diff is a constructor swap plus a refusal pass-through, which keeps it reviewable.

**R14. Network-layer egress is a residual, not part of this change.** Compose has no destination-IP egress filter. Doing it properly needs an egress proxy service with a CONNECT allowlist, or host firewall rules (the `DOCKER-USER` chain), and both are deploy infrastructure. Either would also rewire the F30-proven compose and its e2e (`corpus-compose-policy.yml`). The application-layer boundary is the closure for F25; the egress control is follow-up F25-FU1 (section 5). *Reason:* the brief allows documenting this as a residual when a compose change is not safe, and this one is not without a proxy design.

## 3. Module shape (`scraper/net/fetch_policy.py`)

- `FetchRefused(Exception)` with `.reason`, `.url` (redacted) and `.policy`. It is a plain `Exception`, so the connectors' existing per-URL `except Exception` skips it.
- `FetchPolicy(name, hosts, host_suffixes=(), ports={443})`, frozen, with `check_url(url, previous=None) -> httpx.URL` and `allows(url) -> bool`.
- `is_public_address(ip) -> bool`, with `BLOCKED_NETWORKS`.
- `SOURCE_POLICIES` (name → policy) and `policy_for(name)`.
- `PolicyFetcher` is an async context manager with `allows`, `get(url, headers=None)` and `post(url, json=None, headers=None)`. Both return `FetchedResponse(url, status_code, headers, content, text)`.
- `fetcher_for(name, *, headers=None)` is the production factory. Connectors look it up on the module at call time (`fetch_policy.fetcher_for`), so tests can substitute it.
- `SyncPolicyFetcher` and `sync_fetcher_for(name, *, headers=None)` run the same async fetcher on a private event loop, so there is one enforcement implementation.
- The transport replaces httpx's private `_pool` with an `httpcore.AsyncConnectionPool(network_backend=_GuardedBackend)`. Construction fails closed (`RuntimeError`) if httpx's layout changes. A unit test asserts that the pool uses the guarded backend, and the loopback e2e proves it end to end. httpx is pinned to 0.28.1 in `requirements-test.txt`.

## 4. Tests

**E2E (the real flow, real Postgres): `corpus_service/tests/test_f25_fetch_boundary_e2e.py`.**
- **The servers.**
  - An HTTPS source server on `localhost` uses a test CA generated at run time. It serves two reporter pages.
  - A plain-HTTP "internal service" on 127.0.0.1 counts every TCP connection and every request, and answers with a canary.
- **The reporter page links:**
  - two legitimate absolute case links on the source origin;
  - the internal service by `127.0.0.1` at a metadata-style path (`/latest/meta-data/iam/security-credentials/case.htm`);
  - the internal service by `localhost`, by the decimal literal `2130706433`, and over https on the internal port;
  - a userinfo link to the source origin;
  - a source-origin page that 302s to the internal service.
- **The run.**
  - The test runs the Celery task the beat schedule fires, `dispatcher.run_source_job("NasirLawSite")`. That goes through the dispatcher's trust gate and the real `scrape_nasirlawsite`, staging rows into a fresh Postgres database.
  - `REPORTER_URLS` points at the source server.
  - Main's client (`trust_env` on) trusts the test CA through `SSL_CERT_FILE`, set by the test.
  - After the fix, the test substitutes `fetch_policy.fetcher_for` with a `PolicyFetcher` whose policy allowlists **only** `localhost:<source port>`, with the loopback hook for that origin and the test CA. On a pre-F25 tree the module does not exist, so there is nothing to configure and the harvest runs as main ships it.
- **Asserted.**
  - (a) The internal service saw 0 connections and 0 requests.
  - (b) No staging row holds the canary or points at the internal service or the userinfo URL.
  - (c) Exactly the two legitimate case pages are staged with their text, so the harvest still works.
  - (d) Each refused link is logged with its reason.
- **Expected results.** On main, (a) fails: the internal service receives the metadata-path request, among others. After the fix, every check passes.

**Unit and integration (no database): `corpus_service/tests/test_f25_fetch_policy.py`.**
- **URL classes:**
  - plain http and other schemes;
  - userinfo, and the `@` and backslash tricks;
  - a non-default port, and port 0;
  - a host off the allowlist, and suffix look-alikes;
  - IP literals in dotted, decimal, hex, octal-ish and short forms, plus bracketed IPv6 and IPv4-mapped forms;
  - IDN and punycode homoglyphs;
  - a trailing dot, and a percent-encoded host.
- **Address classes:**
  - every IPv4 private, loopback, link-local, CGNAT, multicast, reserved and documentation range;
  - the named metadata IPs (169.254.169.254, 169.254.170.2, 100.100.100.200, fd00:ec2::254);
  - IPv6 loopback, unspecified, ULA, link-local, site-local, multicast, IPv4-mapped, NAT64, 6to4 and Teredo;
  - public controls.
- **Backend:**
  - a hostname resolving to a private address;
  - mixed public and private records;
  - **DNS rebinding:** the first resolution is public and the second is private. The first connect goes to the vetted IP, never the hostname. The second is refused before any connect.
  - Unix sockets are refused, and an empty answer is refused.
- **Fetcher against local servers:**
  - a redirect to a private host;
  - a redirect to a non-allowlisted host;
  - an allowlisted name that resolves privately (the address layer, through a redirect);
  - a scheme downgrade;
  - a redirect loop past 5 hops;
  - a same-origin redirect, which is followed;
  - the body cap and the deadline;
  - a POST that is not redirected.
- **Nasir connector without a database** (fake session): relative links resolve against the fetched page, and refused links cost no request.
- **Hooks:** refused outside `development`.

**Guard and registry: `corpus_service/tests/test_f25_fetch_guard.py`.** It covers R12, the scanner's positive controls, and the registry/seed consistency of R4.

**Changed expectations.** `tests/test_f20_harvesters_db.py` replaced the network by monkeypatching `httpx.AsyncClient`. No connector constructs that any more, so its offline harness now substitutes the new seam, `fetch_policy.fetcher_for`, with the same canned responses (plus `allows`). Its assertions (source stamping, trusted-only direct writes) are unchanged.

## 5. Residuals and follow-ups

1. **Network-layer egress (F25-FU1).**
   - The application boundary covers every corpus source fetch. A process-level compromise (code execution in the worker) is not contained by it.
   - **Follow-up:** put `worker-embed` (which runs the harvest tasks) behind an egress proxy that allowlists the `SOURCE_POLICIES` hosts by CONNECT, and the OpenAI API host. Add host `DOCKER-USER` rules that drop the worker bridge's traffic to `169.254.0.0/16`, the RFC 1918 ranges outside the compose `data` network, and `100.64.0.0/10`.
   - This needs proxy support in `fetch_policy`: an explicit proxy with the address check moved to the proxy, because R9 ignores the environment.
2. **Third-party SDK clients are out of scope.** The OpenAI SDK (embeddings) talks to a fixed configured endpoint, not to page-chosen URLs. It is not a source fetch, and F25-FU1's proxy covers it at the network layer.
3. **Plain-http document links on court pages are refused** (R3). If a source turns out to publish documents only over http, the fix is an explicit http upgrade for that policy's hosts. Never a plaintext fetch.
4. **NAT64/DNS64 hosts are refused** (R6a).
5. **F26 stays open.** Parser isolation, decompressed, page and time limits on PDF parsing, and the bounded PDF downloader are F26. This change only bounds bytes and time at the fetch boundary.
6. **Coupling to httpx internals.** The transport replaces httpx's private `_pool`. A future httpx release could move it; construction then raises, and the unit test and the e2e fail, so it cannot silently degrade.
