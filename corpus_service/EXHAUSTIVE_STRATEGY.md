# Exhaustive Citation Strategy

PakistanLawSite has no sitemap. Must brute-force search.

Search form: POST /Login/CitationSearch {year, book, code="", court="", judge="", lawyer="", party=""}
book mapping: PLD, SCMR, CLC, PCrLJ=PCRLJ, PTD, PLC, CLD, YLR, MLD, GBLR

Year walk: 2026 down to 1947, cycling journals per seat:
Seat A: PLD 2026, SCMR 2026, CLC 2026, PCrLJ 2026, PLD 2025...
Seat B: PTD 2026, PLC 2026, YLR 2026, MLD 2026, CLD 2026, GBLR 2026...

For each search, parse rows for caseId (casetypeid). For each caseId not in harvest-seen.json:
POST /Login/GetCaseFile JSON {"caseName": caseId, "headNotes":"0"} -> full HTML 12-220KB
Clean: strip script/style, decode entities, remove msoNormal, @page, MicrosoftInternetExplorer4
Validate >=1500 chars else mark seen but not count
Write REAL PDF via reportlab to Blackletter / Pakistan Law Site / 01 Caselaw / {journal} / {year} / {court} / {citation} [{caseId}].pdf
Validate >15KB, contains citation
Only then add to seen via atomic tmp+rename
Enqueue to drive-outbox.jsonl

Statutes: pakistancode.gov.pk slug list + nasirlawsite.com/laws/ index, split_into_sections 5 strategies.

Cloud: Docker volume /app/live persists, restart unless-stopped, runs even when PC off, you pull when on.