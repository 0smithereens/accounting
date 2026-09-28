/**
 * 端到端集成测试。
 *
 * 自己生成小规模的 Excel / Word 文件 → 走完整管线 → 校验凭证。
 * 这是最有价值的一组测试：单元测试只能证明某个函数对，
 * 这里证明「从文件到凭证」的整条链路对。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { PROJECT_ROOT, loadConfig } from '../src/core/config.ts';
import type { DocumentRecord } from '../src/core/types.ts';
import { run } from '../src/pipeline.ts';
import { buildVouchers, summarizeVouchers } from '../src/ledger/voucher.ts';
import { processFile } from '../src/pipeline.ts';
import {
  extractContractAmount,
  extractContractChineseAmount,
  extractTaxRate,
} from '../src/extract/contract.ts';

const TMP_DIR = join(PROJECT_ROOT, 'out', '.test-tmp');

/* ------------------------------------------------------------------ */
/* 测试数据构造                                                        */
/* ------------------------------------------------------------------ */

async function writeBankXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('流水');
  // 前面放三行标题，验证表头探测能力
  ws.getCell('A1').value = '中国工商银行客户存款对账单';
  ws.getCell('A3').value = '统计期间：2024-01-01 至 2024-01-31';
  ws.getRow(4).values = ['交易日期', '摘要', '对方户名', '借方发生额', '贷方发生额', '余额'];

  const rows: Array<[string, string, string, number | null, number | null, number]> = [
    ['2024-01-03', '收到货款', '深圳华强电子有限公司', null, 158000, 1358000],
    ['2024-01-05', '支付货款', '东莞精密制造有限公司', 96000, null, 1262000],
    ['2024-01-05', '跨行转账手续费', '', 25, null, 1261975],
    ['2024-01-12', '活期结息', '', null, 1862.35, 1263837.35],
    ['2024-01-18', '备用金提现', '', 20000, null, 1243837.35],
    ['2024-01-25', '理财申购', '工银理财', 500000, null, 743837.35],
    ['2024-01-28', '支付电费', '国网上海市电力公司', 8432.6, null, 735404.75],
    ['2024-01-31', '账户管理费', '', 180, null, 735224.75],
  ];
  rows.forEach((r, i) => {
    ws.getRow(5 + i).values = r;
  });

  const total = ws.getRow(5 + rows.length);
  total.getCell(2).value = '合计';
  total.getCell(4).value = 624637.6;
  total.getCell(5).value = 159862.35;

  await wb.xlsx.writeFile(path);
}

async function writeInvoiceXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('发票');
  ws.getRow(1).values = [
    '发票号码', '开票日期', '发票种类', '购方名称', '销方名称',
    '货物或应税劳务名称', '金额', '税率', '税额', '价税合计',
  ];

  const company = '示例科技有限公司';
  const rows: Array<[string, string, string, string, string, string, number, number]> = [
    // 进项-专票-货物
    ['240101', '2024-01-04', '增值税专用发票', company, '东莞精密制造有限公司', '电子元器件', 100000, 0.13],
    // 进项-普票-服务（不可抵扣）
    ['240102', '2024-01-09', '增值税普通发票', company, '广州云智软件有限公司', '技术服务费', 50000, 0.06],
    // 销项-专票
    ['240103', '2024-01-05', '增值税专用发票', '上海远景科技有限公司', company, '智能控制器', 300000, 0.13],
  ];

  rows.forEach((r, i) => {
    const tax = Math.round(r[6] * r[7] * 100) / 100;
    const row = ws.getRow(2 + i);
    row.values = [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], tax, Math.round((r[6] + tax) * 100) / 100];
  });

  await wb.xlsx.writeFile(path);
}

async function writeExpenseXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('费用');
  ws.getRow(1).values = ['报销日期', '报销人', '部门', '费用类别', '事由', '金额', '税额'];
  ws.getRow(2).values = ['2024-01-08', '张伟', '销售部', '差旅费', '客户拜访差旅', 3680.5, 208.33];
  ws.getRow(3).values = ['2024-01-15', '赵敏', '行政部', '水电费', '12月水电费', 4832.6, null];
  ws.getRow(4).values = ['2024-01-22', '陈静', '财务部', '咨询顾问费', '年度审计费', 30000, 1698.11];
  await wb.xlsx.writeFile(path);
}

async function writePayrollXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('工资');
  ws.getRow(1).values = [
    '姓名', '部门', '基本工资', '绩效奖金', '应发合计',
    '个人社保', '个人公积金', '个人所得税', '实发合计', '单位社保', '单位公积金',
  ];

  const employees: Array<[string, string, number, number, number, number, number, number, number]> = [
    ['张伟', '销售部', 12000, 15000, 2520, 1680, 2890, 3240, 1440],
    ['王强', '技术部', 18000, 10000, 3780, 2520, 3980, 4860, 2160],
    ['周涛', '生产部', 8500, 3500, 1785, 1190, 310, 2295, 1020],
  ];

  employees.forEach((e, i) => {
    const [name, dept, base, bonus, social, fund, tax, empSocial, empFund] = e;
    const gross = base + bonus;
    const net = gross - social - fund - tax;
    ws.getRow(2 + i).values = [name, dept, base, bonus, gross, social, fund, tax, net, empSocial, empFund];
  });

  await wb.xlsx.writeFile(path);
}

/** 生成一个最小但合法的 .docx。 */
async function writeContractDocx(path: string): Promise<void> {
  const para = (text: string): string =>
    `<w:p><w:r><w:t xml:space="preserve">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;

  const body = [
    '设备采购合同',
    '合同编号：HT-2024-0116',
    '甲方（采购方）：示例科技有限公司',
    '乙方（供应方）：江苏精工机械有限公司',
    '合同总金额（含税）：人民币 904,000.00 元',
    '大写：人民币玖拾万零肆仟元整。',
    '增值税税率 13%。',
    '结算方式：银行转账。',
    '付款方式：合同签订后支付预付款 30%，验收合格后支付进度款 60%，质保期满支付尾款 10%。',
    '合同期限：自2024年1月16日起至2024年12月31日止。',
    '签订日期：2024年01月16日',
  ].map(para).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels')?.file('.rels', rels);
  zip.folder('word')?.file('document.xml', documentXml);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

/* ------------------------------------------------------------------ */

describe('端到端：从文件到凭证', () => {
  const files = {
    bank: join(TMP_DIR, 'bank.xlsx'),
    invoice: join(TMP_DIR, 'invoice.xlsx'),
    expense: join(TMP_DIR, 'expense.xlsx'),
    payroll: join(TMP_DIR, 'payroll.xlsx'),
    contract: join(TMP_DIR, 'contract.docx'),
  };

  before(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await writeBankXlsx(files.bank);
    await writeInvoiceXlsx(files.invoice);
    await writeExpenseXlsx(files.expense);
    await writePayrollXlsx(files.payroll);
    await writeContractDocx(files.contract);
  });

  after(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it('自动识别每类文件的单据类型', async () => {
    const config = loadConfig();
    const expectations: Array<[string, string]> = [
      [files.bank, 'bank'],
      [files.invoice, 'invoice'],
      [files.expense, 'expense'],
      [files.payroll, 'payroll'],
      [files.contract, 'contract'],
    ];
    for (const [file, expected] of expectations) {
      const result = await processFile(file, { config });
      assert.equal(result.kind, expected, `${file} 应识别为 ${expected}`);
      assert.ok(result.documents.length > 0, `${file} 应提取到单据`);
    }
  });

  it('银行流水能跳过标题行与合计行，并正确判断收付', async () => {
    const config = loadConfig();
    const result = await processFile(files.bank, { config });
    // 8 条流水，合计行必须被跳过
    assert.equal(result.documents.length, 8, `应提取 8 条流水，实际 ${result.documents.length}`);

    const received = result.documents.find((d) => d.summary.includes('收到货款'));
    assert.equal(received?.direction, 'in');
    assert.equal(received?.amount, 15800000);

    const paid = result.documents.find((d) => d.summary.includes('支付货款'));
    assert.equal(paid?.direction, 'out');
    assert.equal(paid?.amount, 9600000);

    // 合计行不应出现在结果里
    assert.ok(!result.documents.some((d) => d.summary.includes('合计')));
  });

  it('发票能区分进项/销项并完成价税分离', async () => {
    const config = loadConfig();
    const result = await processFile(files.invoice, { config });
    assert.equal(result.documents.length, 3);

    const input = result.documents.find((d) => d.fields['invoiceSide'] === 'input');
    assert.ok(input, '应识别出进项发票');
    assert.equal(input.netAmount, 10000000);
    assert.equal(input.taxAmount, 1300000);
    assert.equal(input.amount, 11300000);
    assert.equal(input.netAmount + input.taxAmount, input.amount, '价税合计必须等于不含税+税额');
    assert.equal(input.fields['deductible'], 'yes');

    const normal = result.documents.find((d) => d.fields['invoiceType'] === '增值税普通发票');
    assert.equal(normal?.fields['deductible'], 'no', '普通发票不可抵扣进项税');

    const output = result.documents.find((d) => d.fields['invoiceSide'] === 'output');
    assert.ok(output, '应识别出销项发票');
    assert.equal(output.direction, 'in');
  });

  it('报销单带税额时拆分不含税与税额，不带税额时全额入账', async () => {
    const config = loadConfig();
    const result = await processFile(files.expense, { config });
    assert.equal(result.documents.length, 3);

    const withTax = result.documents.find((d) => d.summary.includes('差旅费'));
    assert.ok(withTax);
    assert.equal(withTax.amount, 368050);
    assert.equal(withTax.taxAmount, 20833);
    assert.equal(withTax.netAmount, 368050 - 20833);
    assert.equal(withTax.fields['hasTax'], true);

    const noTax = result.documents.find((d) => d.summary.includes('水电费'));
    assert.ok(noTax);
    assert.equal(noTax.fields['hasTax'], false);
    assert.equal(noTax.netAmount, null);
  });

  it('工资表产出 计提 + 发放 + 单位社保 三类单据，且勾稽平衡', async () => {
    const config = loadConfig();
    const result = await processFile(files.payroll, { config });

    const accruals = result.documents.filter((d) => d.fields['stage'] === 'accrual');
    const payments = result.documents.filter((d) => d.fields['stage'] === 'payment');
    const employer = result.documents.filter((d) => d.fields['stage'] === 'employer-contribution');

    assert.equal(accruals.length, 3, '每名员工一条计提单据');
    assert.equal(payments.length, 1, '全表汇总一条发放单据');
    assert.ok(employer.length >= 1, '应有单位承担社保公积金单据');

    const payment = payments[0];
    assert.ok(payment);
    // 应发 = 实发 + 个税 + 个人社保 + 个人公积金
    const gross = Number(payment.fields['grossPay']);
    const net = Number(payment.fields['netPay']);
    const tax = Number(payment.fields['tax']);
    const si = Number(payment.fields['socialInsurance']);
    const hf = Number(payment.fields['housingFund']);
    assert.ok(
      Math.abs(gross - (net + tax + si + hf)) < 0.01,
      `工资勾稽不符：应发 ${gross} ≠ 实发 ${net} + 个税 ${tax} + 社保 ${si} + 公积金 ${hf}`,
    );
  });

  it('Word 合同能抽取要素并交叉校验大小写金额', async () => {
    const config = loadConfig();
    const result = await processFile(files.contract, { config });
    assert.equal(result.documents.length, 1);

    const doc = result.documents[0];
    assert.ok(doc);
    assert.equal(doc.kind, 'contract');
    assert.equal(doc.amount, 90400000, '合同金额应为 904,000 元');
    assert.equal(doc.date, '2024-01-16');
    assert.equal(doc.fields['contractNo'], 'HT-2024-0116');
    assert.equal(doc.fields['partyA'], '示例科技有限公司');
    assert.equal(doc.fields['partyB'], '江苏精工机械有限公司');
    assert.equal(doc.fields['role'], 'purchaser', '我方是甲方，应为采购方');
    assert.equal(doc.fields['settled'], false, '合同未提及款项已收付');
    assert.equal(doc.fields['taxRate'], 0.13);
  });

  it('完整管线：全部凭证借贷平衡且试算平衡', async () => {
    const result = await run(
      [files.bank, files.invoice, files.expense, files.payroll, files.contract],
      { config: loadConfig(), period: '2024-01' },
    );

    assert.ok(result.vouchers.length > 0, '应生成凭证');

    for (const voucher of result.vouchers) {
      assert.equal(
        voucher.totalDebit,
        voucher.totalCredit,
        `凭证 ${voucher.word} 借贷不平：借 ${voucher.totalDebit} 贷 ${voucher.totalCredit}`,
      );
      assert.equal(voucher.balanced, true);
    }

    const summary = summarizeVouchers(result.vouchers);
    assert.equal(summary.totalDebit, summary.totalCredit, '全部凭证试算必须平衡');
    assert.equal(summary.unbalancedCount, 0);

    // 不应出现规则配置错误导致的错误级问题
    const errors = result.issues.filter((i) => i.level === 'error');
    assert.deepEqual(errors.map((e) => e.message), [], '不应出现错误级问题');
  });

  it('合同只登记台账，不生成凭证', async () => {
    const result = await run([files.contract], { config: loadConfig(), period: '2024-01' });
    assert.equal(result.vouchers.length, 0, '单纯签合同不产生记账凭证');
    assert.ok(
      result.issues.some((i) => i.level === 'info' && i.message.includes('合同')),
      '应给出「仅登记台账」的提示',
    );
  });

  it('银行代发工资与工资表重复时只记一次', async () => {
    const config = loadConfig();
    // 先跑一次工资表，拿到实发合计
    const payrollOnly = await run([files.payroll], { config, period: '2024-01' });
    const payment = payrollOnly.documents.find((d) => d.fields['stage'] === 'payment');
    assert.ok(payment);
    const netPay = Number(payment.fields['netPay']);

    // 造一份含「代发工资」的银行流水，金额等于实发合计
    const bankPath = join(TMP_DIR, 'bank-with-payroll.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('流水');
    ws.getRow(1).values = ['交易日期', '摘要', '对方户名', '借方发生额', '贷方发生额'];
    ws.getRow(2).values = ['2024-01-08', '代发工资', '代发工资户', netPay, null];
    await wb.xlsx.writeFile(bankPath);

    const withDedup = await run([files.payroll, bankPath], { config, period: '2024-01' });
    assert.equal(withDedup.stats.duplicates, 1, '应识别出 1 条重复业务');
    assert.ok(
      withDedup.issues.some((i) => i.message.includes('重复业务已去重')),
      '应给出重复业务的说明',
    );

    // 应付职工薪酬-工资 应当归零（计提 = 发放），说明没有重复记账
    const wages = withDedup.vouchers
      .flatMap((v) => v.lines)
      .filter((l) => l.accountCode === '2211.01');
    const debit = wages.reduce((s, l) => s + l.debit, 0);
    const credit = wages.reduce((s, l) => s + l.credit, 0);
    assert.equal(debit, credit, `应付职工薪酬-工资 应轧平，实际借 ${debit} 贷 ${credit}`);

    // 关闭去重后会重复记账
    const noDedup = await run([files.payroll, bankPath], { config, period: '2024-01', noDedup: true });
    assert.equal(noDedup.stats.duplicates, 0);
    const wages2 = noDedup.vouchers.flatMap((v) => v.lines).filter((l) => l.accountCode === '2211.01');
    const debit2 = wages2.reduce((s, l) => s + l.debit, 0);
    const credit2 = wages2.reduce((s, l) => s + l.credit, 0);
    assert.notEqual(debit2, credit2, '关闭去重后应出现重复记账（这正是去重要解决的问题）');
  });

  it('缺少日期的单据可用 --period 兜底', async () => {
    const noDatePath = join(TMP_DIR, 'no-date.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('流水');
    ws.getRow(1).values = ['交易日期', '摘要', '借方发生额'];
    ws.getRow(2).values = [null, '支付货款', 1000];
    await wb.xlsx.writeFile(noDatePath);

    const result = await run([noDatePath], { config: loadConfig(), period: '2024-03' });
    assert.equal(result.vouchers.length, 1);
    assert.equal(result.vouchers[0]?.date, '2024-03-01');
    assert.equal(result.vouchers[0]?.period, '2024-03');
  });

  it('无法识别的表头给出可操作的错误提示', async () => {
    const weirdPath = join(TMP_DIR, 'weird.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getRow(1).values = ['甲', '乙', '丙'];
    ws.getRow(2).values = ['x', 'y', 'z'];
    await wb.xlsx.writeFile(weirdPath);

    const result = await processFile(weirdPath, { config: loadConfig() });
    assert.equal(result.kind, 'unknown');
    assert.ok(result.documents.length === 0);
    const error = result.issues.find((i) => i.level === 'error');
    assert.ok(error, '应给出错误提示');
    assert.ok(error.message.includes('--kind'), '提示里应告诉用户如何手动指定类型');
    assert.ok(error.message.includes('表头'), '提示里应回显识别到的表头');
  });

  it('合同税率抽取：分隔符不会吃掉数字（回归测试）', () => {
    // 曾经的 bug：分隔符字符类写成 [^：:\n]{0,12} 时，
    // 正则回溯会把「税率 13%」的「1」吃掉，误读成 3%。
    assert.equal(extractTaxRate('增值税税率 13%'), 0.13);
    assert.equal(extractTaxRate('增值税税率：13%'), 0.13);
    assert.equal(extractTaxRate('增值税税率13%'), 0.13);
    assert.equal(extractTaxRate('增值税税率 为 6%'), 0.06);
    assert.equal(extractTaxRate('适用税率：9％'), 0.09);
    assert.equal(extractTaxRate('征收率 3%'), 0.03);
    assert.equal(extractTaxRate('本合同总金额壹拾万元整'), null);
    assert.equal(extractTaxRate('预付款比例 30%，进度款 60%'), null, '付款比例不应被当成税率');
  });

  it('合同金额抽取：小写与大写交叉校验', () => {
    assert.equal(
      extractContractAmount('合同总金额（含税）：人民币 904,000.00 元').amount,
      90400000,
    );
    assert.equal(extractContractAmount('合同价款：￥1,234,567.89').amount, 123456789);
    assert.equal(extractContractChineseAmount('大写：人民币玖拾万零肆仟元整。'), 90400000);
    assert.equal(extractContractChineseAmount('人民币大写：壹万贰仟叁佰肆拾伍元陆角柒分'), 1234567);
  });

  it('借贷不平时自动配平并挂待处理科目', async () => {
    // 直接构造一条会算不平的规则，验证配平逻辑本身
    const config = loadConfig();
    const brokenConfig = {
      ...config,
      rules: {
        ...config.rules,
        rules: [
          {
            id: 'broken-rule',
            priority: 9999,
            kinds: ['bank' as const],
            when: { summary: ['测试不平'] },
            then: {
              entries: [
                { side: 'debit' as const, account: '1901', amount: 'total' as const },
                { side: 'debit' as const, account: '6602.05', amount: 'field.extra' as const },
                { side: 'credit' as const, account: '1002', amount: 'total' as const },
              ],
            },
          },
          ...config.rules.rules,
        ],
      },
    };

    const document: DocumentRecord = {
      id: 'unbalanced-1',
      kind: 'bank',
      date: '2024-01-05',
      summary: '测试不平',
      amount: 100000,           // 1000.00 元
      direction: 'out',
      counterparty: null,
      netAmount: null,
      taxAmount: null,
      fields: { extra: '500.00' },  // 500.00 元
      source: { file: 'unbalanced.xlsx', row: 2 },
      warnings: [],
    };

    const { vouchers, issues } = buildVouchers([document], brokenConfig, { defaultPeriod: '2024-01' });
    assert.equal(vouchers.length, 1);
    const voucher = vouchers[0];
    assert.ok(voucher);

    assert.equal(voucher.balanced, true, '自动配平后凭证必须平衡');
    assert.equal(voucher.totalDebit, voucher.totalCredit);
    assert.equal(voucher.totalDebit, 150000, '借方合计应为 1000.00 + 500.00');
    assert.ok(
      voucher.lines.some((l) => l.summary.includes('系统配平')),
      '应出现系统配平分录',
    );
    assert.ok(
      issues.some((i) => i.level === 'error' && i.message.includes('借贷不平')),
      '应报出错误级问题',
    );

    // 关闭自动配平后，凭证保持不平并如实标注
    const manual = buildVouchers([document], brokenConfig, {
      defaultPeriod: '2024-01',
      autoBalance: false,
    });
    assert.equal(manual.vouchers[0]?.balanced, false);
    assert.notEqual(manual.vouchers[0]?.totalDebit, manual.vouchers[0]?.totalCredit);
  });
});
