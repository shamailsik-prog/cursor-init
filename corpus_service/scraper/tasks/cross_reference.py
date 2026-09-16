import logging
from sqlalchemy import select, func
from scraper.database import SessionLocal
from scraper.models import CaseLawMaster
logger = logging.getLogger(__name__)

async def cross_reference_citations():
    async with SessionLocal() as db:
        result = await db.execute(select(CaseLawMaster))
        all_cases = result.scalars().all()
        # build citation count
        citation_map = {}
        for case in all_cases:
            if case.citations_cited:
                for cited in case.citations_cited:
                    citation_map[cited] = citation_map.get(cited, 0)+1
        # update
        for case in all_cases:
            if case.citation and case.citation in citation_map:
                case.citation_count = citation_map[case.citation]
                if case.citation_count>=10:
                    case.is_landmark=True
        await db.commit()
        logger.info(f"Cross-referenced {len(citation_map)} citations")
        return len(citation_map)

def cross_reference_citations_sync():
    import asyncio
    return asyncio.run(cross_reference_citations())
