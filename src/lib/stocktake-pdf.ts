export type StocktakePdfLine = {
  name: string;
  sku: string;
  unit: string;
};

export type StocktakePdfInput = {
  countNumber: string;
  category: string;
  preparedAt: Date;
  notes?: string | null;
  lines: StocktakePdfLine[];
};

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN_X = 12;
const TABLE_BOTTOM = 272;
const COLUMN_X = [12, 20, 93, 122, 145, 172, 198] as const;

function labelCategory(category: string) {
  return category === "all"
    ? "All categories"
    : category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function createStocktakePdf(input: StocktakePdfInput) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const categoryLabel = labelCategory(input.category);
  const preparedLabel = new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Lagos",
  }).format(input.preparedAt);

  doc.setProperties({
    title: `Central Stocktake - ${input.countNumber} - ${categoryLabel}`,
    subject: "Blind physical stocktake count sheet",
    author: "4ruit Naturel",
    creator: "Juice Operations Hub",
  });

  function drawPageHeader() {
    doc.setTextColor(232, 112, 35);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("4RUIT NATUREL", MARGIN_X, 14);

    doc.setTextColor(28, 45, 35);
    doc.setFontSize(16);
    doc.text("CENTRAL INVENTORY PHYSICAL STOCKTAKE", MARGIN_X, 22);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(70, 70, 70);
    doc.text(`Count reference: ${input.countNumber}`, MARGIN_X, 28);
    doc.text(`Category: ${categoryLabel}`, MARGIN_X, 33);
    doc.text(`Prepared: ${preparedLabel}`, 112, 28);
    doc.text(`Products: ${input.lines.length}`, 112, 33);

    doc.setFillColor(255, 248, 230);
    doc.setDrawColor(230, 177, 72);
    doc.roundedRect(MARGIN_X, 37, PAGE_WIDTH - MARGIN_X * 2, 13, 1.5, 1.5, "FD");
    doc.setTextColor(82, 63, 19);
    doc.setFontSize(7.5);
    const instruction =
      "BLIND COUNT: Write the quantity physically seen for every row. Enter 0 where none. Record damaged, expired or unusual stock in Notes.";
    doc.text(doc.splitTextToSize(instruction, PAGE_WIDTH - MARGIN_X * 2 - 6), 15, 42.5);
  }

  function drawTableHeader(y: number) {
    doc.setFillColor(31, 95, 61);
    doc.setDrawColor(31, 95, 61);
    doc.rect(MARGIN_X, y, PAGE_WIDTH - MARGIN_X * 2, 8, "FD");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    const labels = ["NO.", "PRODUCT", "SKU", "UNIT", "PHYSICAL COUNT", "NOTES / CONDITION"];
    labels.forEach((label, index) => {
      doc.text(label, COLUMN_X[index] + 1.5, y + 5.2);
    });
    return y + 8;
  }

  function startPage(addPage = false) {
    if (addPage) doc.addPage();
    drawPageHeader();
    return drawTableHeader(54);
  }

  let y = startPage();
  input.lines.forEach((line, index) => {
    const itemLines = doc.splitTextToSize(line.name, COLUMN_X[2] - COLUMN_X[1] - 3) as string[];
    const rowHeight = Math.max(10, itemLines.length * 3.7 + 4);
    if (y + rowHeight > TABLE_BOTTOM) y = startPage(true);

    doc.setFillColor(index % 2 === 0 ? 249 : 255, index % 2 === 0 ? 251 : 255, 249);
    doc.setDrawColor(185, 190, 187);
    doc.rect(MARGIN_X, y, PAGE_WIDTH - MARGIN_X * 2, rowHeight, "FD");
    for (const x of COLUMN_X.slice(1, -1)) doc.line(x, y, x, y + rowHeight);

    doc.setTextColor(35, 35, 35);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(String(index + 1), COLUMN_X[0] + 1.5, y + 5.8);
    doc.text(itemLines, COLUMN_X[1] + 1.5, y + 4.8);
    doc.setFontSize(7);
    doc.text(line.sku || "-", COLUMN_X[2] + 1.5, y + 5.8);
    doc.text(line.unit || "-", COLUMN_X[3] + 1.5, y + 5.8);
    y += rowHeight;
  });

  const signoffHeight = input.notes?.trim() ? 33 : 25;
  if (y + signoffHeight > TABLE_BOTTOM) y = startPage(true);
  y += 6;
  doc.setTextColor(55, 55, 55);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("COUNT SIGN-OFF", MARGIN_X, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.text("Counted by: __________________________", MARGIN_X, y);
  doc.text("Signature: __________________________", 78, y);
  doc.text("Time completed: __________________", 145, y);
  y += 9;
  doc.text("Checked by: __________________________", MARGIN_X, y);
  doc.text("Signature: __________________________", 78, y);
  doc.text("Date checked: _____________________", 145, y);
  if (input.notes?.trim()) {
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.text("Stocktake instructions:", MARGIN_X, y);
    doc.setFont("helvetica", "normal");
    doc.text(doc.splitTextToSize(input.notes.trim(), 140), 46, y);
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(205, 208, 206);
    doc.line(MARGIN_X, 282, PAGE_WIDTH - MARGIN_X, 282);
    doc.setTextColor(105, 105, 105);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text(`${input.countNumber} - ${categoryLabel}`, MARGIN_X, 287);
    doc.text(`Page ${page} of ${pageCount}`, PAGE_WIDTH - MARGIN_X, 287, { align: "right" });
  }

  return doc;
}

export async function downloadStocktakePdf(input: StocktakePdfInput) {
  const doc = await createStocktakePdf(input);
  const filename = `central-stocktake-${safeFilename(input.countNumber)}-${safeFilename(input.category)}.pdf`;
  doc.save(filename);
  return filename;
}
