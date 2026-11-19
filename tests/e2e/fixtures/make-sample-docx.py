"""Generate tests/e2e/fixtures/sample.docx — a minimal real Word file."""
import sys, zipfile

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

def para(text, *, heading=False):
    size = '<w:sz w:val="32"/><w:b/>' if heading else ''
    return (
        '<w:p><w:pPr><w:bidi/><w:jc w:val="right"/>'
        f'<w:rPr><w:rtl/>{size}</w:rPr></w:pPr>'
        f'<w:r><w:rPr><w:rtl/>{size}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
    )

def cell(text):
    return (
        '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>'
        + para(text)
        + '</w:tc>'
    )

BORDERS = (
    '<w:tblBorders>'
    + ''.join(
        f'<w:{side} w:val="single" w:sz="8" w:space="0" w:color="C00000"/>'
        for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV')
    )
    + '</w:tblBorders>'
)

TABLE = (
    '<w:tbl><w:tblPr><w:bidiVisual/>'
    '<w:tblW w:w="4800" w:type="dxa"/>' + BORDERS + '</w:tblPr>'
    '<w:tr>' + cell('תאריך') + cell('יעד') + '</w:tr>'
    '<w:tr>' + cell('20.11.2026') + cell('ירושלים') + '</w:tr>'
    '</w:tbl>'
)

DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:document {W}><w:body>'
    + para('אישור הורים לטיול השנתי', heading=True)
    + para('נא לחתום ולהחזיר לכיתה עד יום חמישי.')
    + TABLE
    + para('בתודה, צוות בית הספר')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>'
      '<w:bidi/></w:sectPr>'
    '</w:body></w:document>'
)

out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    # The OPC spec wants [Content_Types].xml first in the archive.
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    z.writestr('_rels/.rels', RELS)
    z.writestr('word/document.xml', DOCUMENT)
print('wrote', out)
