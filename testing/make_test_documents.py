"""Builds the sample documents for trying the Receive tab in test mode:

testing/test-packing-slip.pdf
    A fictional vendor's packing list for the Test Product (TEST-S, TEST-M,
    TEST-L), order TEST-0001. Size L was short-shipped: 2 ordered, 1 shipped.
    Read it as a packing slip. Expected review: S 4, M 6 and L 1 received
    (L shows "Ordered 2"), 11 pieces in all, no costs.

testing/test-invoice.pdf
    The same vendor's invoice TEST-0001: the Test Product in a size grid
    (S 4, M 6, L 2 at $10.00), a screen print line, a set-up fee and freight.
    Read it as an invoice. Expected review: new cost $11.50 on each size
    ($10.00 garment + $1.50 logos), set-up fees $12.00 for department 10's
    report (in test mode, the test department), freight $9.50 not in item
    cost, and totals matching $159.50. No stock is added.

Standard library only, so it runs anywhere:
    python3 testing/make_test_documents.py
"""

import os

# Helvetica and Helvetica-Bold advance widths for ASCII 32..126 (1/1000 em),
# needed to right-align numbers.
REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
           556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
           1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
           667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
           333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
           556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
        975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
        333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
        611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]

ops = []   # drawing operators for the page being built


def width(s, size, bold):
    table = BOLD if bold else REGULAR
    return sum(table[ord(c) - 32] for c in s) * size / 1000


def text(x, y, s, size=10, bold=False, align="left", grey=0.0):
    if align == "right":
        x -= width(s, size, bold)
    s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ops.append(f"BT {grey} g /{'F2' if bold else 'F1'} {size} Tf {x:.2f} {y:.2f} Td ({s}) Tj ET")


def rule(x1, y1, x2, y2, grey=0.6, w=0.6):
    ops.append(f"{grey} G {w} w {x1} {y1} m {x2} {y2} l S")


def box(x, y, w, h, rgb):
    ops.append(f"{rgb[0]} {rgb[1]} {rgb[2]} rg {x} {y} {w} {h} re f")


L, R = 54, 558
HERE = os.path.dirname(os.path.abspath(__file__))


def write_pdf(filename, title):
    content = "\n".join(ops).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Title (" + title.encode("latin-1") + b") /Author (Rexius apparel app) >>",
    ]
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    pdf += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    pdf += b"trailer\n<< /Size %d /Root 1 0 R /Info 7 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    out = os.path.join(HERE, filename)
    with open(out, "wb") as f:
        f.write(pdf)
    print(f"Wrote {out} ({len(pdf)} bytes)")
    ops.clear()


def draw_invoice():

    # Faint watermark first, so everything else prints over it.
    ops.append("BT 0.93 g /F2 150 Tf 0.8192 0.5736 -0.5736 0.8192 150 230 Tm (TEST) Tj ET")

    text(L, 730, "TEST VENDOR CO.", 18, bold=True)
    text(L, 714, "100 Example Way")
    text(L, 701, "Testville, OR 00000")
    text(L, 688, "(555) 010-0100")

    text(R, 726, "INVOICE", 24, bold=True, align="right")
    for i, (label, value) in enumerate([("Invoice no.", "TEST-0001"), ("Invoice date", "11/02/2026"),
                                        ("Terms", "Net 30"), ("Customer PO", "TEST")]):
        y = 706 - 13 * i
        text(400, y, label, 10, grey=0.35)
        text(R, y, value, 10, bold=True, align="right")

    box(L, 626, R - L, 28, (0.99, 0.92, 0.87))
    text(L + 10, 636, "TEST DOCUMENT - NOT A REAL INVOICE. Made for trying out the Rexius apparel app. Do not pay.", 10, bold=True)

    text(L, 600, "BILL TO", 9, bold=True, grey=0.35)
    text(L, 586, "Rexius")
    text(L, 573, "Apparel program (testing)")
    text(300, 600, "SHIP TO", 9, bold=True, grey=0.35)
    text(300, 586, "Same as bill to")

    # Line items: a size grid for the garment, then decoration and set-up.
    cols = [(L + 4, "ITEM #", "left"), (104, "DESCRIPTION", "left"), (250, "COLOR", "left"),
            (350, "S", "right"), (378, "M", "right"), (406, "L", "right"),
            (446, "QTY", "right"), (502, "UNIT PRICE", "right"), (R - 4, "AMOUNT", "right")]
    box(L, 528, R - L, 18, (0.90, 0.91, 0.90))
    for x, label, align in cols:
        text(x, 534, label, 8.5, bold=True, align=align)

    rows = [
        ["TP-100", "Test Product", "Safety Green", "4", "6", "2", "12", "10.00", "120.00"],
        ["DEC-1", "Screen print, left chest", "", "", "", "", "12", "1.50", "18.00"],
        ["SETUP", "Screen set-up fee", "", "", "", "", "1", "12.00", "12.00"],
    ]
    y = 512
    for row in rows:
        for (x, _, align), value in zip(cols, row):
            if value:
                text(x, y, value, 10, align=align)
        rule(L, y - 8, R, y - 8, grey=0.8)
        y -= 22

    for i, (label, value) in enumerate([("Subtotal", "150.00"), ("Freight", "9.50"), ("Sales tax", "0.00")]):
        yy = 428 - 16 * i
        text(400, yy, label)
        text(R - 4, yy, value, align="right")
    rule(400, 384, R, 384, grey=0.2, w=1)
    text(400, 368, "TOTAL DUE", 11, bold=True)
    text(R - 4, 368, "$159.50", 11, bold=True, align="right")

    text(L, 300, "Thank you for your business. Questions? Call (555) 010-0100.", 10, grey=0.35)
    text(L, 286, "SAMPLE FOR TESTING ONLY. Test Vendor Co. is not a real company.", 9, grey=0.35)


def draw_packing_slip():
    ops.append("BT 0.93 g /F2 150 Tf 0.8192 0.5736 -0.5736 0.8192 150 230 Tm (TEST) Tj ET")

    text(L, 730, "TEST VENDOR CO.", 18, bold=True)
    text(L, 714, "100 Example Way")
    text(L, 701, "Testville, OR 00000")
    text(L, 688, "(555) 010-0100")

    text(R, 726, "PACKING LIST", 24, bold=True, align="right")
    for i, (label, value) in enumerate([("Order no.", "TEST-0001"), ("Ship date", "11/02/2026"), ("Ship via", "Ground")]):
        y = 706 - 13 * i
        text(400, y, label, 10, grey=0.35)
        text(R, y, value, 10, bold=True, align="right")

    box(L, 626, R - L, 28, (0.99, 0.92, 0.87))
    text(L + 10, 636, "TEST DOCUMENT - NOT A REAL SHIPMENT. Made for trying out the Rexius apparel app.", 10, bold=True)

    text(L, 600, "SHIP TO", 9, bold=True, grey=0.35)
    text(L, 586, "Rexius")
    text(L, 573, "Apparel program (testing)")

    cols = [(L + 4, "ITEM #", "left"), (114, "DESCRIPTION", "left"), (250, "COLOR", "left"), (340, "SIZE", "left"),
            (420, "ORDERED", "right"), (480, "SHIPPED", "right"), (R - 4, "BACKORDER", "right")]
    box(L, 528, R - L, 18, (0.90, 0.91, 0.90))
    for x, label, align in cols:
        text(x, 534, label, 8.5, bold=True, align=align)
    rows = [
        ["TP-100-S", "Test Product", "Safety Green", "S", "4", "4", "0"],
        ["TP-100-M", "Test Product", "Safety Green", "M", "6", "6", "0"],
        ["TP-100-L", "Test Product", "Safety Green", "L", "2", "1", "1"],
    ]
    y = 512
    for row in rows:
        for (x, _, align), value in zip(cols, row):
            text(x, y, value, 10, align=align)
        rule(L, y - 8, R, y - 8, grey=0.8)
        y -= 22

    text(400, 428, "Pieces shipped", 10)
    text(R - 4, 428, "11", 10, bold=True, align="right")
    text(L, 380, "Size L: 1 piece on backorder.", 10)
    text(L, 300, "Please check your shipment against this list. Questions? Call (555) 010-0100.", 10, grey=0.35)
    text(L, 286, "SAMPLE FOR TESTING ONLY. Test Vendor Co. is not a real company.", 9, grey=0.35)


draw_packing_slip()
write_pdf("test-packing-slip.pdf", "Test packing list TEST-0001")
draw_invoice()
write_pdf("test-invoice.pdf", "Test invoice TEST-0001")
