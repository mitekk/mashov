"""Generate the e2e Word fixtures.

    python3 make-sample-docx.py sample.docx     # the benign document
    python3 make-sample-docx.py hostile.docx    # the crafted one (see README)
"""
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

# --- the hostile variant -----------------------------------------------------
#
# Two vectors, both of which the viewer must neutralize. They are not
# hypothetical: `renderHyperlink` assigns `a.href` from the relationship with no
# scheme check, and `encloseFontFamily` leaves a whitespace-free font name
# unquoted, so it escapes its declaration block in the generated stylesheet.

BEACON_URL = 'https://evil.example/beacon.png'
EVIL_FONT = 'a}*{background-image:url(' + BEACON_URL + ')}x{y:z'
EVIL_HREF = 'javascript:window.__docxPwned=1;void 0'

HOSTILE_CONTENT_TYPES = CONTENT_TYPES.replace(
    '</Types>',
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument'
    '.wordprocessingml.styles+xml"/></Types>',
)

DOC_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rIdStyles" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/>'
    f'<Relationship Id="rIdEvil" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
    f'Target="{EVIL_HREF}" TargetMode="External"/>'
    '</Relationships>'
)

STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:styles {W}>'
    '<w:style w:type="paragraph" w:styleId="Evil"><w:name w:val="Evil"/>'
    f'<w:rPr><w:rFonts w:ascii="{EVIL_FONT}" w:hAnsi="{EVIL_FONT}"/></w:rPr>'
    '</w:style></w:styles>'
)

HOSTILE_DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:document {W} '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<w:body>'
    '<w:p><w:pPr><w:pStyle w:val="Evil"/><w:bidi/></w:pPr>'
    '<w:r><w:rPr><w:rtl/></w:rPr><w:t>מסמך בדיקה</w:t></w:r></w:p>'
    '<w:p><w:pPr><w:bidi/></w:pPr>'
    '<w:hyperlink r:id="rIdEvil">'
    '<w:r><w:rPr><w:rtl/></w:rPr><w:t>לחצו כאן לאישור</w:t></w:r>'
    '</w:hyperlink></w:p>'
    '</w:body></w:document>'
)

out = sys.argv[1]
hostile = out.endswith('hostile.docx')

# A fixed timestamp, so regenerating a fixture whose text has not changed
# produces identical bytes instead of a no-op binary diff.
EPOCH = (1980, 1, 1, 0, 0, 0)


def add(z, name, text):
    info = zipfile.ZipInfo(name, date_time=EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    z.writestr(info, text)


with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    # The OPC spec wants [Content_Types].xml first in the archive.
    add(z, '[Content_Types].xml', HOSTILE_CONTENT_TYPES if hostile else CONTENT_TYPES)
    add(z, '_rels/.rels', RELS)
    add(z, 'word/document.xml', HOSTILE_DOCUMENT if hostile else DOCUMENT)
    if hostile:
        add(z, 'word/_rels/document.xml.rels', DOC_RELS)
        add(z, 'word/styles.xml', STYLES)

print('wrote', out)
