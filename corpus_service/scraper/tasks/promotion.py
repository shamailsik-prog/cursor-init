import logging
from sqlalchemy import select
from scraper.database import SessionLocal
from scraper.models import ScraperStaging, CaseLawMaster, QuarantineQueue
logger = logging.getLogger(__name__)

async def promote_staging_records():
    async with SessionLocal() as db:
        result = await db.execute(select(ScraperStaging).where(ScraperStaging.normalised==True, ScraperStaging.promoted==False, ScraperStaging.quarantined==False))
        records = result.scalars().all()
        promoted=0
        for st in records:
            # check duplicate
            if st.extracted_citation:
                from sqlalchemy import select as sel
                dup = await db.execute(sel(CaseLawMaster).where(CaseLawMaster.citation==st.extracted_citation))
                if dup.scalars().first():
                    continue
            # trust level check
            from scraper.models import ScraperSource
            src_res = await db.execute(sel(ScraperSource).where(ScraperSource.source_name==st.source_site))
            src = src_res.scalars().first()
            trust = src.trust_level if src else "trusted"
            if trust=="blocked":
                continue
            if trust=="review":
                # quarantine
                qq = QuarantineQueue(staging_id=st.id, source_site=st.source_site, source_url=st.source_url, extracted_citation=st.extracted_citation, extracted_title=st.extracted_title, reason="review source")
                db.add(qq)
                st.quarantined=True
                await db.commit()
                continue
            # trusted + confidence >=0.5 -> auto promote
            if st.confidence_score>=0.5:
                master = CaseLawMaster(citation=st.extracted_citation, case_title=st.extracted_title, court=st.extracted_court, year=st.extracted_year, reporter=st.extracted_reporter, full_text=st.raw_text, source_site=st.source_site, source_url=st.source_url, confidence_score=st.confidence_score, is_promoted=True)
                db.add(master)
                await db.flush()
                # embedding queue
                from scraper.models import EmbeddingQueue
                eq = EmbeddingQueue(record_id=master.id, table_name="case_law_master")
                db.add(eq)
                st.promoted=True
                promoted+=1
            else:
                qq = QuarantineQueue(staging_id=st.id, source_site=st.source_site, source_url=st.source_url, extracted_citation=st.extracted_citation, reason=f"low confidence {st.confidence_score}")
                db.add(qq)
                st.quarantined=True
            await db.commit()
        logger.info(f"Promoted {promoted} records")
        return promoted
