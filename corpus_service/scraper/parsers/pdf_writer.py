from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
import os, pathlib, logging
logger = logging.getLogger(__name__)
def write_judgment_pdf(path: pathlib.Path, meta: dict, cleaned_text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.pdf")
    doc = SimpleDocTemplate(str(tmp), pagesize=A4, leftMargin=0.8*inch, rightMargin=0.8*inch, topMargin=0.8*inch, bottomMargin=0.8*inch)
    styles = getSampleStyleSheet()
    story=[]
    caption = f"<b>{meta.get('court','')}</b><br/>{meta.get('title','')}<br/>Citation: {meta.get('citation','')} | Journal: {meta.get('journal','')} | Year: {meta.get('year','')} | CaseID: {meta.get('caseId','')}"
    story.append(Paragraph(caption, styles["Heading3"]))
    story.append(Spacer(1, 0.2*inch))
    safe = cleaned_text[:100000]
    for para in safe.split("\n\n"):
        if len(para.strip())<2: continue
        esc = para.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
        story.append(Paragraph(esc[:5000], styles["Normal"]))
        story.append(Spacer(1, 0.08*inch))
    footer = f"Harvested {meta.get('timestamp','')} | {meta.get('seat','')} | {meta.get('caseId','')}"
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph(footer, styles["Italic"]))
    doc.build(story)
    os.replace(tmp, path)
    size = path.stat().st_size
    logger.info(f"Wrote PDF {path} {size} bytes")
    return size
