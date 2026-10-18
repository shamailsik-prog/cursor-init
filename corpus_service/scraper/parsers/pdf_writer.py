import os, pathlib, logging
from xml.sax.saxutils import escape
logger = logging.getLogger(__name__)


def _field(meta: dict, key: str) -> str:
    """A metadata value as text that is safe inside reportlab Paragraph markup (audit F25 re-audit,
    LOW 7). Paragraph parses its text as markup, and an <img src="..."> there is fetched when the PDF
    is built, so harvested metadata (titles, citations) must never reach it unescaped."""
    return escape(str(meta.get(key, "")))


def write_judgment_pdf(path: pathlib.Path, meta: dict, cleaned_text: str):
    # reportlab is imported here, not at module level, so the module (and its escaping) can be
    # imported and tested without the PDF stack installed.
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import inch

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.pdf")
    doc = SimpleDocTemplate(str(tmp), pagesize=A4, leftMargin=0.8*inch, rightMargin=0.8*inch, topMargin=0.8*inch, bottomMargin=0.8*inch)
    styles = getSampleStyleSheet()
    story=[]
    caption = f"<b>{_field(meta, 'court')}</b><br/>{_field(meta, 'title')}<br/>Citation: {_field(meta, 'citation')} | Journal: {_field(meta, 'journal')} | Year: {_field(meta, 'year')} | CaseID: {_field(meta, 'caseId')}"
    story.append(Paragraph(caption, styles["Heading3"]))
    story.append(Spacer(1, 0.2*inch))
    safe = cleaned_text[:100000]
    for para in safe.split("\n\n"):
        if len(para.strip())<2: continue
        esc = escape(para[:5000])  # truncate before escaping, so an entity is never cut in half
        story.append(Paragraph(esc, styles["Normal"]))
        story.append(Spacer(1, 0.08*inch))
    footer = f"Harvested {_field(meta, 'timestamp')} | {_field(meta, 'seat')} | {_field(meta, 'caseId')}"
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph(footer, styles["Italic"]))
    doc.build(story)
    os.replace(tmp, path)
    size = path.stat().st_size
    logger.info(f"Wrote PDF {path} {size} bytes")
    return size
