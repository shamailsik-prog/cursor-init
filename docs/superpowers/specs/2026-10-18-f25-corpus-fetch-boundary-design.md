# F25: one fetch boundary for every corpus source (design)

**Finding.** Audit F25 (HIGH, P0), `docs/audit/2026-10-13-forensic-audit.md:567`: "Nasir source links can drive unrestricted HTTP requests." Every absolute http link on a Nasir reporter page whose href contains `case` or `.htm` is fetched with no host, IP, port or redirect control (`corpus_service/scraper/tasks/nasirlawsite.py:36-41` on main 1f0cc27). The source HTML is external input, not configuration. The other connectors' host checks do not protect this path. Recommended correction: route all fetches through one HTTPS allowlist client; validate the hostname, the resolved public IPs, the port, each redirect and the final origin; block private and link-local destinations; enforce network egress restrictions.

**Rule for closure** (`docs/audit/REMEDIATION.md`): a merged PR with an end-to-end test of the real flow that fails on main and passes after, then an independent re-audit.

## 1. What main does today (every outbound path in `corpus_service/`)

| Path | Who picks the URL | Host control | Redirects | IP / DNS control |
|---|---|---|---|---|
| `scraper/tasks/nasirlawsite.py:31-41` | the reporter page (any `href` with `case` or `.htm`; absolute links taken as is) | none | not followed (httpx default) | none |
| `scraper/tasks/nationalassembly.py:8-19` | the NA index page (any `.pdf` link whose text says Act/Ordinance; absolute links taken as is) | none | not followed | none |
| `scraper/tasks/pakistancode.py:9-18` | fixed URLs in code | n/a | not followed | none |
| `scraper/tasks/shc.py:132, 184` | listing pages and inline scripts | `host.endswith("sindhhighcourt.gov.pk")` or `endswith("shc.gov.pk")` (no dot anchor), http allowed | **followed** (`follow_redirects=True`) to any host | none |
| `scraper/tasks/supremecourt.py:157, 211` | listing pages, sitemap text | `endswith("supremecourt.gov.pk")`, http allowed | **followed** | none |
| `scraper/tasks/lahorehighcourt.py:101, 155` | listing pages, inline text | `endswith("lhc.gov.pk")`, http allowed | discovery **followed**; PDFs not | none |
| `scraper/tasks/peshawarhighcourt.py:183, 241` | listing pages | exact host set, http allowed, any port | **followed** | none |
| `scraper/tasks/balochistanhighcourt.py:187, 241` | listing pages, `data-*` attributes | exact host set, any port | **followed** | none |
| `scraper/tasks/islamabadhighcourt.py:276, 364` | listing pages, AJAX feed JSON (`ATTACHMENTS`) | exact host set, any port | **followed** (GET and POST) | none |
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
- Bodies are capped at 100 MiB. That matches `pdf_extractor.MAX_PDF_SIZE_BYTES`. **Corrected in the re-audit round (section 6):** as first shipped, this line also said "counted after content decoding (gzip bombs count by output)", which was false. The count ran on httpx's already-inflated chunks, so a bomb was inflated before the cap could refuse it. R17 replaces this rule.
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

Connector discovery filters stay as they are. They are heuristics; the boundary is the fetcher. Nasir now resolves relative links against the page it actually fetched (`urljoin`). For the real reporter URLs that gives the same result as main's hard-coded prefix, and it stops `//host/x` from being glued onto the Nasir host. Nasir drops refused links **before** taking its 20 per page, so hostile links cannot crowd out real ones.

Two behaviour changes follow from routing, both deliberate: every GET now follows up to 5 *allowlisted* redirects, including Lahore's PDF fetch, which on main did not follow redirects at all; and a court link published over plain http is refused (R3, residual 3). *Reason:* routing only Nasir would leave the redirect, IP and port holes in nine other paths. The per-connector diff is a constructor swap plus a refusal pass-through, which keeps it reviewable.

**R14. Network-layer egress is a residual, not part of this change.** Compose has no destination-IP egress filter. Doing it properly needs an egress proxy service with a CONNECT allowlist, or host firewall rules (the `DOCKER-USER` chain), and both are deploy infrastructure. Either would also rewire the F30-proven compose and its e2e (`corpus-compose-policy.yml`). The application-layer boundary is the closure for F25; the egress control is follow-up F25-FU1 (section 5). *Reason:* the brief allows documenting this as a residual when a compose change is not safe, and this one is not without a proxy design.

## 3. Module shape (`scraper/net/fetch_policy.py`)

- `FetchRefused(Exception)` with `.reason`, `.url` (redacted) and `.policy`. It is a plain `Exception`, so the connectors' existing per-URL `except Exception` skips it.
- `FetchPolicy(name, hosts, host_suffixes=(), ports={443})`, frozen, with `check_url(url, previous=None) -> httpx.URL` and `allows(url) -> bool`.
- `is_public_address(ip) -> bool`, with `BLOCKED_NETWORKS`.
- `SOURCE_POLICIES` (name → policy) and `policy_for(name)`.
- `PolicyFetcher` is an async context manager with `allows`, `get(url, headers=None)` and `post(url, json=None, headers=None)`. Both return `FetchedResponse(url, status_code, headers, content, text)`.
- `fetcher_for(name, *, headers=None)` is the production factory. Connectors look it up on the module at call time (`fetch_policy.fetcher_for`), so tests can substitute it.
- `SyncPolicyFetcher` and `sync_fetcher_for(name, *, headers=None)` run the same async fetcher on a private event loop, so there is one enforcement implementation.
- `PolicyFetcher(policy, *, headers=None, max_bytes=MAX_BYTES, deadline=DEADLINE_SECONDS, max_redirects=MAX_REDIRECTS, _test_*=None)`; `get(url, *, headers=None)`, `post(url, *, json=None, headers=None)`. `redact_url(url)` is the one redaction used by the boundary's log line and by `bootstrap_harvest.py`'s provenance rows.
- The transport replaces httpx's private `_pool` with an `httpcore.AsyncConnectionPool(network_backend=_GuardedBackend)`. Construction fails closed (`RuntimeError`) if httpx's layout changes. A unit test asserts that the pool uses the guarded backend, and the loopback e2e proves it end to end.

**R15. httpx is pinned in the runtime set too.** `requirements-test.txt` already pinned `httpx==0.28.1`; `requirements.txt` (the image) did not. It now pins the same version. *Reason:* the guarded transport fails closed on any other httpx layout, so an unpinned image could pull a release that stops every harvester. 0.28.1 is the current PyPI release and has no OSV advisory (checked 2026-10-18), so the pin changes nothing installed today.

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

**Changed expectations.**
- `tests/test_f20_harvesters_db.py` replaced the network by monkeypatching `httpx.AsyncClient`. No connector constructs that any more, so its offline harness now substitutes the new seam, `fetch_policy.fetcher_for`, with the same canned responses (plus `allows`, which is the source's real registered policy, and the response `url` Nasir now joins against). Its assertions (source stamping, trusted-only direct writes) are unchanged.
- A defect in the RED commit's own test, found while going GREEN: `test_the_transport_checks_requests_that_bypass_the_helper` resolved the allowlisted source `localhost` to a real public address (93.184.215.14), so its second request dialled the internet and hit the connect timeout instead of reaching the check under test. Its resolver now answers loopback (reachable through the loopback hook). The assertions are unchanged.

## 5. Residuals and follow-ups

1. **Network-layer egress (F25-FU1).**
   - The application boundary covers every corpus source fetch. A process-level compromise (code execution in the worker) is not contained by it.
   - **Follow-up:** put `worker-embed` (which runs the harvest tasks) behind an egress proxy that allowlists the `SOURCE_POLICIES` hosts by CONNECT, and the OpenAI API host. Add host `DOCKER-USER` rules that drop the worker bridge's traffic to `169.254.0.0/16`, the RFC 1918 ranges outside the compose `data` network, and `100.64.0.0/10`.
   - This needs proxy support in `fetch_policy`: an explicit proxy with the address check moved to the proxy, because R9 ignores the environment.
2. **Third-party SDK clients are out of scope.** The OpenAI SDK (embeddings) talks to a fixed configured endpoint, not to page-chosen URLs. It is not a source fetch, and F25-FU1's proxy covers it at the network layer.
3. **Plain-http document links on court pages are refused** (R3). If a source turns out to publish documents only over http, the fix is an explicit http upgrade for that policy's hosts. Never a plaintext fetch.
4. **NAT64/DNS64 hosts are refused** (R6a).
5. **F26 stays open.** Parser isolation, decompressed, page and time limits on PDF parsing, and the bounded PDF downloader are F26. This change only bounds bytes and time at the fetch boundary.
6. **Coupling to httpx internals.** The transport replaces httpx's private `_pool`. A future httpx release could move it; construction then raises, and the unit test and the e2e fail, so it cannot silently degrade. R15 pins the runtime to the proven version.
7. **Connector log lines outside the boundary.** The boundary's own refusal line redacts userinfo. The court connectors' pre-existing `listing request failed <url>` lines still print the URL as discovered, so a page-planted `user:pass@` (which is refused, never sent) can appear there. Not a request path, so not F25; noted for the logging follow-up.

## 6. Re-audit round (FAIL 7/10)

An independent re-audit of #65 (merged as 04d388f) found that the SSRF boundary itself held. About 95 hostile URL forms, the DNS and redirect attacks and the hooks were all refused, and 34 of 47 mutants were killed. It failed F25 at 7/10 on one MEDIUM finding and eight LOWs. The follow-up branch is `claude/remediate-f25-r2`, from origin/main 04d388f. Each ruling below records the decision and the reason.

**Correction to R8.** R8 and the #65 PR body said the body cap was "counted after content decoding (gzip bombs count by output)". That was false. `_read_capped` counted the output of httpx's `aiter_bytes()`, and httpx's decoders inflate each network chunk with no output limit, so the cap was checked only after a chunk had been inflated in full. The re-audit measured:
- 1.7–1.8 KB bodies with `Content-Encoding: gzip, gzip`, `deflate, deflate` or `br` peaked at about 2,093 MiB RSS before being refused as `too_large`;
- a 5 KB body aimed at 3 GiB raised `MemoryError`;
- `br` is live in production, because weasyprint pulls in brotli, so httpx advertises and decodes it.

On main 04d388f this branch's tests measure (tracemalloc):
- 557.7 MiB for a stacked bomb under 8 KB;
- 45.5 MiB for a single-coding bomb against a 2 MiB cap;
- 142 MiB for a 256 MiB gzip bomb at the production cap.

**R17. The boundary decodes bodies itself, in bounded steps (MEDIUM).**
- Every request sends `Accept-Encoding: gzip`. It is forced in `_send` and at client construction, so a caller's header cannot re-open br or zstd.
- The body is read raw (`aiter_raw()`), so httpx decodes nothing.
- Accepted codings: identity, or exactly one of `gzip` / `x-gzip` / `deflate` (`identity` entries are ignored). Refused before any decoding, as `content_encoding_refused`:
  - stacked codings (`gzip, gzip`, `gzip, deflate`);
  - `br`, `zstd`, `compress`;
  - parameterised or unknown values.
- `_BoundedDecoder` inflates with `zlib.decompressobj(...).decompress(data, 64 KiB)` and feeds `unconsumed_tail` back. No step produces more than 64 KiB, and the decoded total is checked before each write, so memory never exceeds `max_bytes` plus one step.
- `deflate` is the zlib format; a raw deflate stream (no zlib header) is accepted on the first chunk, as httpx does.
- Refused as `content_encoding_refused`:
  - data after the end of the compressed stream (the re-audit's "gztrail");
  - a stream that never ends (truncated);
  - a corrupt stream.
- Bytes on the wire are capped at `max_bytes` too (with no Content-Length, only this cap stops an endless body), and a declared Content-Length over the cap is refused before reading.

*Reason:* the brief's recommended fix. Only gzip is worth advertising: court PDFs are already compressed, and HTML compresses well with gzip. Fail-closed strictness on malformed compressed streams costs nothing for a well-formed server.

**R18. httpx never interprets a redirect (LOW 3).** Even with `follow_redirects=False`, httpx's `send()` builds a `next_request` for every 3xx response. For `Location: https:127.0.0.1:PORT/x`, its `_redirect_url` raised `httpx.InvalidURL` inside `send()`, before the boundary saw the response, and a court retry helper sent the URL three times. Now:
- A response hook (`_hold_location`, public httpx event-hook API) moves every redirect `Location` into a response extension before httpx's redirect code runs.
- The boundary resolves the held value itself and refuses, as `ambiguous_url`:
  - more than one `Location`;
  - leading or trailing whitespace, or control characters;
  - backslashes (a browser reads them as `/`);
  - a scheme without `//`, which httpx's `join` puts on the current origin while its redirect builder reads a host.
- An unparseable `Location` is `unparseable_url`.
- `httpx.InvalidURL`, `UnsupportedProtocol` and `TooManyRedirects` raised anywhere inside `get` / `post` become `FetchRefused`, which the court helpers never retry.
- A 3xx returned as is (a POST) gets its `Location` header back.

*Changed expectation:* `test_the_transport_checks_requests_that_bypass_the_helper` used `follow_redirects=True` on the underlying client to make httpx follow a redirect into the transport check. httpx can no longer follow one at all, so the test now asserts that the 302 comes back unfollowed, and sends the hop's URL directly to show the transport refuses it.

**R19. The body is held once (LOW 4).** On main, a 99 MiB in-cap body cost about 477 MiB peak RSS (re-audit), and a 24 MiB body 48.2 MiB under tracemalloc: the chunk list, the joined copy and an eager `text` copy. Now:
- The decoder writes into one `BytesIO` and hands its buffer over without a copy (`getvalue()` on an unshared buffer).
- `FetchedResponse.text` decodes on access and keeps nothing, so a PDF fetch never pays for text.
- Measured: 24 MiB body 26.6 MiB peak (tracemalloc); 99 MiB body about 102 MiB of fetch RSS.
- What remains is the body itself, plus `BytesIO`'s growth slack (at most about 12.5 %) and one 64 KiB step.

**R20. `_GuardedBackend`'s hooks are gated like `PolicyFetcher`'s (LOW 5).** `resolver`, `loopback_origins` and `inner` raise `RuntimeError` unless ENVIRONMENT is explicitly `development`. `PolicyFetcher` passes none of them in production. The guard flags the `loopback_origins` keyword, any private member of the boundary (`_GuardedBackend`, `_GuardedTransport`), and building `FetchPolicy` or `PolicyFetcher` outside the registry.

**R21. The guard sees through aliases, dynamic imports and indirection (LOW 1).** The PR #65 guard caught only the control among the re-audit probe's 20 forms. The scan, still AST-based and in `tests/test_f25_fetch_guard.py`, now fails on:
1. Importing or referencing a forbidden module or any submodule, by any alias. That covers `urllib.request` reached after only `import urllib.parse`. The forbidden list:
   - HTTP and browser libraries: requests, aiohttp, urllib3, http.client, httplib2, pycurl, playwright, websockets, selenium and the like;
   - the transport stack: httpcore, anyio, h11, h2, trio;
   - raw networking and other protocols: socket, ftplib, smtplib, poplib, imaplib, nntplib, telnetlib, xmlrpc, webbrowser;
   - processes and native code: subprocess, pty, ctypes, cffi.
2. httpx's client and transport classes and module-level request functions, anywhere outside type annotations. That covers calls, aliases (`from httpx import AsyncClient as C`) and subclasses (`class S(httpx.AsyncClient)`).
3. Private members of httpx (`httpx._client`, `httpx._transports`, `httpx.__dict__`) and of the boundary.
4. Connection methods on any receiver: `create_connection`, `connect_tcp`, `open_connection`, `sock_connect`, `wrap_socket`, `urlopen` and the like. That covers `loop.create_connection`, `anyio.connect_tcp` and `httpcore.AnyIOBackend().connect_tcp`.
5. Processes and fetches:
   - `os.system`, `os.popen`, `os.exec*`, `os.spawn*`, `asyncio.create_subprocess_*`;
   - `ssl.get_server_certificate`, `ssl.wrap_socket`;
   - `lxml` `parse` (it fetches URLs);
   - `RobotFileParser` given a URL, and `.set_url`.
6. `getattr` / `setattr` / `delattr` / `vars` / `hasattr` on a network module or the boundary.
7. Dynamic imports. A literal name, constant-folded through `+` and f-strings, is refused when it names a network module. A computed name is refused everywhere except `scraper/tasks/dispatcher.py`, whose `ROUTES` modules the adoption test already checks.
8. `exec` / `eval` / `compile`, `sys.modules` and `__builtins__`: code an AST scan cannot read. No corpus module uses them.
9. Writes to the boundary or a network module (monkeypatching `fetcher_for`, adding to `SOURCE_POLICIES`). `SOURCE_POLICIES` is also a read-only mapping (`MappingProxyType`).
10. `follow_redirects` other than a literal `False`, and the `_test_*` / `loopback_origins` hooks.

Positive controls: each of the 20 probe forms (p17, an attribute-only reference, is flagged too) plus 25 further bypass forms. Negative controls are taken from real corpus code (dispatcher, config TLS, asyncio, os, robots, annotations). Placed in the tree, the auditor's probe file fails the new guard on every one of its 20 functions and its 7 forbidden imports (33 findings); the PR #65 guard flagged only line 94.

*Residual:* any static guard can be evaded by code it does not parse (C extensions, a dependency's own client). That is what F25-FU1's network egress control is for.

**R22. Plain-http links to allowlisted hosts are fetched as https (LOW 8).** *Ruling: upgrade.*
- Every registry policy has `upgrade_http=True`. `PolicyFetcher` (`get`, `post`, `allows`) rewrites an `http` link on the default port (none, or `:80`) to `https` on 443, changing only the scheme, and the result must pass `check_url`.
- Any other http link (another port, a host off the allowlist, userinfo) is refused **as written** (`scheme_not_https` with the original URL), so the log shows what the page said.
- A **redirect** to http is still refused as a downgrade: a server actively moving to plaintext is not a published link.
- `FetchPolicy.check_url` / `allows` stay strict (https only).

*Reason:* the re-audit counted 7 Sindh listing links (shc.gov.pk, enotices.sindhhighcourt.gov.pk) that R3 refused. Upgrading keeps that coverage and never sends plaintext. A host that serves no https fails like any unreachable page. *Note:* a court connector stages the link as published (`source_url` may read `http://...`) while the fetch was https.

**LOW 6.** The e2e's pre-F25 fallback catches `ImportError`. A leftover `scraper/net/` directory, say a lone `__pycache__`, is a namespace package, and `from scraper.net import fetch_policy` then raises `ImportError: cannot import name ...`, not `ModuleNotFoundError`. Shown on the pre-F25 tree: the old fallback was a collection error; the new one reaches the real RED assertion (the internal service reached).

**LOW 7.** `pdf_writer.write_judgment_pdf` (no callers today):
- escapes every metadata value with `xml.sax.saxutils.escape` before reportlab's `Paragraph` parses it as markup (an `<img src=...>` there is fetched at build time);
- truncates body paragraphs before escaping, so an entity is never cut in half;
- imports reportlab inside the function, so the module can be tested with a recording stand-in (reportlab is not in the test set).

**Mutation testing, round 2.** The re-audit's 47 mutants (read from its `mutate.py`, never edited) were re-run against this branch, plus 17 new ones for the round-2 code (N01–N17). Six were re-targeted (M13, M17, M26, M31, M36, M47) because round 2 rewrote the lines they named; each keeps its intent. Results:

| Set | Killed | Survived |
|---|---|---|
| Re-audit's 47 (re-audit: 34 killed) | **43** | 4, all equivalent (below) |
| New for round 2, N01–N17 | **17** | 0; N04, N08 and N15 survived the first run and are killed by tests added in 7cc0cc2 |

- **Killed now, having survived the re-audit:** M07, M09, M16, M25, M31 (re-targeted at the decoded cap), M32, M35, M43, M45.
- **Equivalent survivors.** Each removes one of two layers that refuse the same inputs; both layers stay as defense in depth.
  - **M06** (`inet_aton` forms missed): every form `inet_aton` accepts ends in a decimal, octal or hex label, which the numeric-last-label check also refuses (httpx lowercases `0X`).
  - **M14** (NAT64 `/96` unlisted): `64:ff9b::/96` lies outside 2000::/3, which is refused already.
  - **M17** (`is_global` not required): the explicit lists cover every range Python 3.12 marks non-global. `is_global` stays as a guard against a future Python adding ranges.
  - **M30** (final-origin check off): the final URL is always the request URL already checked.

**Residuals added in this round.**
8. An endless identity (uncompressed) body is held up to `max_bytes` (100 MiB) before it is refused: that is the cap itself.
9. Strict decoding and redirect rules refuse some malformed-but-harmless responses (trailing bytes after gzip, truncated gzip, ambiguous `Location`). They fail closed by design; such a page is logged and skipped.
10. A static guard cannot see code it does not parse (residual of R21); network egress (F25-FU1) is the backstop.
