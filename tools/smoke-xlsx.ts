import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("out5/报表与财务分析-2024-01.xlsx");
console.log("工作表数:", wb.worksheets.length);
for (const ws of wb.worksheets) {
  const firstRows: string[] = [];
  for (let r = 1; r <= Math.min(4, ws.rowCount); r++) {
    const vals: string[] = [];
    ws.getRow(r).eachCell((c) => vals.push(String(c.value ?? "")));
    firstRows.push(vals.slice(0, 5).join(" | "));
  }
  console.log(" - " + ws.name + " (" + ws.rowCount + " 行) " + firstRows[0]);
}
