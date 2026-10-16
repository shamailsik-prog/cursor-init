# Sikander legal research and drafting agent (DataRobot)

`agent_spec.md` is the design-phase spec for a DataRobot-hosted agent that researches and drafts from the
ssa-scraper corpus of Pakistani judgments and statutes, under the owner's drafting and verification standards.

## Status (16 October 2026)

- Design: first draft complete; choices delegated by the owner and recorded at the top of the spec.
- Blocked on: DataRobot credentials (`DATAROBOT_ENDPOINT`, `DATAROBOT_API_TOKEN`) in the cloud environment,
  needed to pick the model, run the dress rehearsal and scaffold the code.
- Prerequisite to build: a read-only corpus API on the scraper droplet (search, judgment by citation, citation
  verification, citing judgments with treatment, statute section), keyed by `SIKANDER_CORPUS_API_KEY` and
  backed by the `sikander_reader` role. Postgres itself is never exposed.

## Next steps

1. Owner adds the DataRobot credentials; start a new session.
2. Choose the model from the LLM Gateway listing; optional dress rehearsal.
3. Build the read-only corpus API in ssa-scraper.
4. Scaffold and code the agent from the DataRobot template; battle-test; deploy.
