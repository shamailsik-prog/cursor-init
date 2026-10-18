"""Synthetic PDF fixtures for the audit F26 tests (not a test module).

Every document is built here, byte for byte, from code: no real judgment, no third-party file. Text is
synthetic and every citation is dated 2099. The builders write plain PDF 1.4 (a classic xref table) or,
for ``objstm=True``, PDF 1.5 with a compressed object stream and a cross-reference stream, so that
names such as ``/JavaScript`` exist only inside deflated data.

Builders:
* ``text_pdf``: pages of text lines in Helvetica (a real text layer pdfplumber extracts).
* ``javascript_pdf``: a text page whose catalog opens a JavaScript action (``objstm`` hides it).
* ``padded_pdf``: a text page plus an unreferenced stream of filler, to reach a byte size.
* ``attachment_pdf``: a text page with a file-attachment annotation whose embedded stream has no ``/Type``.
* ``bomb_pdf``: a page whose content stream inflates to ``inflated_mib`` MiB (a decompression bomb).
* ``slow_pdf``: a page with ``ops`` path operators (CPU time in the parser, little memory).
* ``many_pages_pdf``: ``pages`` pages sharing one tiny content stream.
* ``blank_pdf``: pages with no content at all, of any size (no text layer: the extractor turns to OCR).
* ``log_flood_pdf``: the re-audit's 2.8 KB log flood (F26-FU, FA-corpus-009): a form XObject holding a
  100 KB string and an invalid operator, invoked 200,000 times, so pdfminer logs one warning per call.
* ``active_pdf``: a text page carrying exactly one active-content name (spec R4, R20) and no other.
* ``uri_link_pdf``: a text page with a URI link annotation (accepted, spec R20).
"""

from __future__ import annotations

import zlib
from typing import Dict, Iterable, List, Sequence

HEADER = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
HEADER_15 = b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n"
FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"


def _escape(text: str) -> bytes:
    raw = text.encode("latin-1")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def text_content(lines: Sequence[str], *, size: int = 11, leading: int = 14) -> bytes:
    """A content stream that shows ``lines`` top-down from (72, 740)."""
    out = [b"BT", b"/F1 %d Tf" % size, b"%d TL" % leading, b"72 740 Td"]
    for i, line in enumerate(lines):
        if i:
            out.append(b"T*")
        out.append(b"(" + _escape(line) + b") Tj")
    out.append(b"ET")
    return b"\n".join(out) + b"\n"


def _stream(data: bytes, *, compress: bool, extra: bytes = b"") -> bytes:
    if compress:
        data = zlib.compress(data, 9)
        extra = b" /Filter /FlateDecode" + extra
    return b"<< /Length %d%s >>\nstream\n" % (len(data), extra) + data + b"\nendstream"


def _classic(objects: Dict[int, bytes], root: int, header: bytes = HEADER) -> bytes:
    """Objects (number -> body) written in order, then a classic xref table and trailer."""
    out = bytearray(header)
    offsets = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num + objects[num] + b"\nendobj\n"
    size = max(objects) + 1
    xref_at = len(out)
    out += b"xref\n0 %d\n" % size
    out += b"0000000000 65535 f \n"
    for num in range(1, size):
        if num in offsets:
            out += b"%010d 00000 n \n" % offsets[num]
        else:
            out += b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, root, xref_at)
    return bytes(out)


def _pages(page_contents: List[bytes], *, compress: bool, first_obj: int = 10) -> Dict[int, bytes]:
    """Catalog (1), page tree (2), font (3) and one page + content object per entry."""
    objects: Dict[int, bytes] = {3: FONT}
    kids = []
    num = first_obj
    for content in page_contents:
        page, stream = num, num + 1
        kids.append(page)
        objects[page] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % stream
        )
        objects[stream] = _stream(content, compress=compress)
        num += 2
    objects[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    return objects


def text_pdf(pages: Sequence[Sequence[str]], *, compress: bool = False) -> bytes:
    """A PDF whose page ``i`` shows the lines ``pages[i]``."""
    return _classic(_pages([text_content(lines) for lines in pages], compress=compress), root=1)


def padded_pdf(lines: Sequence[str], total_bytes: int) -> bytes:
    """``text_pdf([lines])`` grown to at least ``total_bytes`` by an unreferenced filler stream (the
    document stays valid: the xref table lists the filler, nothing points at it)."""
    objects = _pages([text_content(lines)], compress=False)
    base = len(_classic(objects, root=1))
    filler = max(total_bytes - base - 64, 0)
    pattern = b"F26 synthetic filler, not part of any judgment. "
    objects[9] = _stream((pattern * (filler // len(pattern) + 1))[:filler], compress=False)
    return _classic(objects, root=1)


def javascript_pdf(lines: Sequence[str], *, objstm: bool = False, escaped: bool = False) -> bytes:
    """A text page whose catalog has ``/OpenAction`` -> ``<< /S /JavaScript /JS (...) >>``.

    ``objstm=False``: the action is a plain object, so ``/JavaScript`` appears in the file's bytes.
    ``objstm=True``: the catalog and the action live in a deflated object stream, indexed by a
    cross-reference stream (PDF 1.5); the file's bytes never spell ``/JS`` or ``/JavaScript``.
    ``escaped=True``: the names are spelled with ``#xx`` escapes (``/J#61vaScript``, ``/J#53``)."""
    objects = _pages([text_content(lines)], compress=True)
    action = b"<< /Type /Action /S /JavaScript /JS (app.alert\\('F26 synthetic fixture'\\);) >>"
    if escaped:
        action = action.replace(b"/JavaScript", b"/J#61vaScript").replace(b"/JS ", b"/J#53 ")
    catalog = b"<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>"
    if not objstm:
        objects[1] = catalog
        objects[5] = action
        return _classic(objects, root=1)
    del objects[1]
    return _with_object_stream(objects, {1: catalog, 5: action}, root=1)


def _with_object_stream(plain: Dict[int, bytes], packed: Dict[int, bytes], root: int) -> bytes:
    """PDF 1.5: ``plain`` objects written directly, ``packed`` ones inside one deflated object
    stream, everything indexed by an (uncompressed) cross-reference stream."""
    out = bytearray(HEADER_15)
    entries = {}  # num -> (type, field2, field3)
    for num in sorted(plain):
        entries[num] = (1, len(out), 0)
        out += b"%d 0 obj\n" % num + plain[num] + b"\nendobj\n"
    objstm_num = max(list(plain) + list(packed)) + 1
    header_parts, body = [], bytearray()
    for index, num in enumerate(sorted(packed)):
        header_parts.append(b"%d %d" % (num, len(body)))
        body += packed[num] + b"\n"
        entries[num] = (2, objstm_num, index)
    head = b" ".join(header_parts) + b"\n"
    data = head + bytes(body)
    entries[objstm_num] = (1, len(out), 0)
    out += b"%d 0 obj\n" % objstm_num + _stream(
        data, compress=True, extra=b" /Type /ObjStm /N %d /First %d" % (len(packed), len(head))
    ) + b"\nendobj\n"
    xref_num = objstm_num + 1
    entries[xref_num] = (1, len(out), 0)
    size = xref_num + 1
    rows = bytearray()
    for num in range(size):
        kind, f2, f3 = entries.get(num, (0, 0, 65535 if num == 0 else 0))
        rows += bytes([kind]) + f2.to_bytes(4, "big") + f3.to_bytes(2, "big")
    out += b"%d 0 obj\n" % xref_num + _stream(
        bytes(rows), compress=False,
        extra=b" /Type /XRef /Size %d /W [1 4 2] /Index [0 %d] /Root %d 0 R" % (size, size, root),
    ) + b"\nendobj\n"
    out += b"startxref\n%d\n%%%%EOF\n" % entries[xref_num][1]
    return bytes(out)


def _deflate_repeated(unit: bytes, total: int) -> bytes:
    """zlib data that inflates to ``unit`` repeated up to ``total`` bytes, built in bounded steps."""
    z = zlib.compressobj(9)
    block = unit * max(1, (1 << 20) // len(unit))
    out, left = [], total
    while left > 0:
        piece = block if left >= len(block) else block[:left]
        out.append(z.compress(piece))
        left -= len(piece)
    out.append(z.flush())
    return b"".join(out)


def _single_deflated_page(content_zlib: bytes) -> bytes:
    objects = _pages([b""], compress=False)
    stream_obj = max(objects)
    objects[stream_obj] = b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(content_zlib) + content_zlib + b"\nendstream"
    return _classic(objects, root=1)


def _zlib_of_spaces(mib: int) -> bytes:
    """A zlib stream that inflates to ``mib`` MiB of spaces, about a thousandth of that in size, built
    in well under a second: each MiB is deflated once behind a full flush (which resets the
    compressor's history, so every later MiB deflates to the same bytes) and the copies are joined."""
    chunk = b" " * (1 << 20)
    z = zlib.compressobj(9, zlib.DEFLATED, -15)
    first = z.compress(chunk) + z.flush(zlib.Z_FULL_FLUSH)
    repeat = z.compress(chunk) + z.flush(zlib.Z_FULL_FLUSH)
    tail = z.flush(zlib.Z_FINISH)
    adler = 1
    for _ in range(mib):
        adler = zlib.adler32(chunk, adler)
    return b"\x78\xda" + first + repeat * (mib - 1) + tail + adler.to_bytes(4, "big")


def bomb_pdf(inflated_mib: int) -> bytes:
    """A one-page PDF whose content stream is ``inflated_mib`` MiB of spaces once inflated (about a
    thousandth of that on disk). The parser has to inflate it to read the page."""
    return _single_deflated_page(_zlib_of_spaces(inflated_mib))


def attachment_pdf(lines: Sequence[str]) -> bytes:
    """A text page carrying a FileAttachment annotation. The embedded file stream has no ``/Type``
    and the catalog has no ``/EmbeddedFiles`` tree: only ``/FileAttachment`` and ``/EF`` give it away."""
    objects = _pages([text_content(lines)], compress=True)
    page = min(k for k in objects if k >= 10)
    objects[page] = objects[page][:-2] + b" /Annots [6 0 R] >>"
    objects[6] = (b"<< /Type /Annot /Subtype /FileAttachment /Rect [72 72 90 90] "
                  b"/FS << /Type /Filespec /F (f26.txt) /EF << /F 7 0 R >> >> >>")
    objects[7] = _stream(b"F26 synthetic attachment, not a real file.", compress=False)
    return _classic(objects, root=1)


def blank_pdf(pages: int = 1, *, width: int = 612, height: int = 792) -> bytes:
    """``pages`` pages with an empty content stream and a MediaBox of ``width`` x ``height`` points."""
    objects: Dict[int, bytes] = {3: FONT, 4: _stream(b"", compress=False)}
    kids = [10 + i for i in range(pages)]
    for kid in kids:
        objects[kid] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents 4 0 R >>" % (width, height)
    objects[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), pages)
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    return _classic(objects, root=1)


def slow_pdf(ops: int) -> bytes:
    """A one-page PDF whose content stream holds ``ops`` rectangle-and-discard path operators: the
    parser tokenises every one (CPU), nothing is painted or kept (little memory)."""
    unit = b"0 0 1 1 re n\n"
    return _single_deflated_page(_deflate_repeated(unit, len(unit) * ops))


def many_pages_pdf(pages: int, line: str = "F26 synthetic page. 2099 SCMR 1.") -> bytes:
    """``pages`` pages, all pointing at one shared content stream."""
    objects: Dict[int, bytes] = {3: FONT, 4: _stream(text_content([line]), compress=True)}
    first = 10
    kids = [first + i for i in range(pages)]
    for kid in kids:
        objects[kid] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"
        )
    objects[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), pages)
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    return _classic(objects, root=1)


def judgment_lines(n: int, *, seed: str = "A") -> List[str]:
    """Synthetic judgment text: ``n`` numbered lines, each with a 2099 citation. Not a real case."""
    return [
        f"{i + 1}. Synthetic F26 fixture {seed}: the appeal in C.A. {i + 1}/2099 is considered; "
        f"see 2099 SCMR {100 + i} (not a real judgment)."
        for i in range(n)
    ]


def pages_of(lines: Iterable[str], per_page: int) -> List[List[str]]:
    lines = list(lines)
    return [lines[i:i + per_page] for i in range(0, len(lines), per_page)] or [[]]


def log_flood_pdf(invocations: int = 200_000, string_bytes: int = 100_000) -> bytes:
    """The re-audit's flood (``probes/write_flood_pdf.py``, 2,777 bytes at the defaults): one page
    whose content invokes form XObject /X ``invocations`` times; the form's content is a
    ``string_bytes`` string followed by ``G`` (set gray), which takes a number, so pdfminer logs a
    warning quoting the operand at every invocation. No text is shown."""
    form_content = b"(" + b"A" * string_bytes + b") G\n"
    page_content = zlib.compress(b"/X Do\n" * invocations, 9)
    form = zlib.compress(form_content, 9)
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [10 0 R] /Count 1 >>",
        3: FONT,
        10: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X 12 0 R >> >> /Contents 11 0 R >>",
        11: b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(page_content) + page_content + b"\nendstream",
        12: b"<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length %d /Filter /FlateDecode >>\nstream\n" % len(form)
            + form + b"\nendstream",
    }
    return _classic(objects, root=1)


# One construct per active-content name (spec R4 and R20), built so that the document carries that
# name and no other listed one: removing the name from the policy must let the document through.
# Each entry: extra objects (numbers 5-9), what the catalog gains, and which extra objects are the
# page's annotations.
_ACTIVE = {
    "Launch": ({5: b"<< /S /Launch /F (f26-synthetic.exe) >>"}, b"/OpenAction 5 0 R", ()),
    "EmbeddedFile": ({5: _stream(b"F26 synthetic embedded file, not a real file.", compress=False, extra=b" /Type /EmbeddedFile")}, b"", ()),
    "EmbeddedFiles": ({5: b"<< /Type /Filespec /F (f26-synthetic.txt) >>"}, b"/Names << /EmbeddedFiles << /Names [(f26-synthetic.txt) 5 0 R] >> >>", ()),
    "EF": ({5: b"<< /Type /Filespec /F (f26-synthetic.txt) /EF << /F 6 0 R >> >>",
            6: _stream(b"F26 synthetic file, not a real file.", compress=False)}, b"", ()),
    "FileAttachment": ({5: b"<< /Type /Annot /Subtype /FileAttachment /Rect [72 72 90 90] /FS (f26-synthetic.txt) >>"}, b"", (5,)),
    "RichMedia": ({5: b"<< /Type /Annot /Subtype /RichMedia /Rect [72 72 90 90] >>"}, b"", (5,)),
    "OnInstantiate": ({5: _stream(b"F26 synthetic 3D data", compress=False, extra=b" /Type /3D /Subtype /U3D /OnInstantiate 6 0 R"),
                       6: _stream(b"// F26 synthetic 3D script, not a real script", compress=False)}, b"", ()),
    "3DD": ({5: b"<< /Type /Annot /Subtype /3D /Rect [72 72 90 90] /3DD 6 0 R >>",
             6: _stream(b"F26 synthetic 3D data", compress=False, extra=b" /Type /3D /Subtype /U3D")}, b"", (5,)),
    "GoToR": ({5: b"<< /S /GoToR /F (f26-synthetic-remote.pdf) /D [0 /Fit] >>"}, b"/OpenAction 5 0 R", ()),
    "GoToE": ({5: b"<< /S /GoToE /T << /R /C /N (f26-synthetic) >> /D [0 /Fit] >>"}, b"/OpenAction 5 0 R", ()),
    "SubmitForm": ({5: b"<< /S /SubmitForm /F << /FS /URL /F (https://f26.invalid/submit) >> /Flags 4 >>"}, b"/OpenAction 5 0 R", ()),
    "ImportData": ({5: b"<< /S /ImportData /F (f26-synthetic.fdf) >>"}, b"/OpenAction 5 0 R", ()),
}
ACTIVE_NAMES = tuple(_ACTIVE)


def _page_with(lines: Sequence[str], extra: Dict[int, bytes], catalog: bytes = b"", annots: Sequence[int] = ()) -> bytes:
    objects = _pages([text_content(lines)], compress=True)
    objects.update(extra)
    if catalog:
        objects[1] = b"<< /Type /Catalog /Pages 2 0 R " + catalog + b" >>"
    if annots:
        page = min(k for k in objects if k >= 10)
        objects[page] = objects[page][:-2] + b" /Annots [" + b" ".join(b"%d 0 R" % a for a in annots) + b"] >>"
    return _classic(objects, root=1)


def active_pdf(name: str, lines: Sequence[str]) -> bytes:
    """A text page carrying the active-content name ``name`` (one of ``ACTIVE_NAMES``) and no other."""
    extra, catalog, annots = _ACTIVE[name]
    return _page_with(lines, extra, catalog, annots)


def uri_link_pdf(lines: Sequence[str]) -> bytes:
    """A text page with a link annotation whose action opens a web address (a judgment citing a
    statute online does this)."""
    link = b"<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /A << /S /URI /URI (https://f26.invalid/statutes/2099) >> >>"
    return _page_with(lines, {5: link}, annots=(5,))
