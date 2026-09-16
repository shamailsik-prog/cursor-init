import logging, time, asyncio
from scraper.database import SessionLocal
from sqlalchemy import select
from scraper.models import EmbeddingQueue, CaseLawMaster, StatutesMaster
logger = logging.getLogger(__name__)

async def process_embedding_queue():
    from scraper.config import settings
    if not settings.OPENAI_API_KEY:
        logger.info("No OPENAI_API_KEY, skip embeddings")
        return 0
    try:
        import openai
        client = openai.AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        async with SessionLocal() as db:
            result = await db.execute(select(EmbeddingQueue).where(EmbeddingQueue.status=="pending").limit(50))
            queue_items = result.scalars().all()
            count=0
            for item in queue_items:
                try:
                    if item.table_name=="case_law_master":
                        res = await db.execute(select(CaseLawMaster).where(CaseLawMaster.id==item.record_id))
                        rec = res.scalars().first()
                        if not rec: continue
                        embed_text = f"{rec.citation or ''} {rec.case_title or ''} {rec.full_text[:2000] if rec.full_text else ''}"
                    else:
                        res = await db.execute(select(StatutesMaster).where(StatutesMaster.id==item.record_id))
                        rec = res.scalars().first()
                        if not rec: continue
                        embed_text = f"{rec.statute_name or ''} {rec.section_number or ''} {rec.section_text[:2000] if rec.section_text else ''}"
                    emb = await client.embeddings.create(model="text-embedding-3-small", input=embed_text)
                    vector = emb.data[0].embedding
                    rec.embedding = vector
                    item.status="done"
                    await db.commit()
                    count+=1
                    await asyncio.sleep(0.6)  # 100 RPM limit
                except Exception as e:
                    logger.error(f"Embedding failed {item.id}: {e}")
                    item.attempts+=1
                    item.status="failed" if item.attempts>=3 else "pending"
                    await db.commit()
            return count
    except Exception as e:
        logger.error(f"Embedding queue error {e}")
        return 0

def process_embedding_queue_sync():
    return asyncio.run(process_embedding_queue())
