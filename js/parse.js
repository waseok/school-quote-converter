// 견적서 읽기: 지마켓·옥션(.xls 확장자지만 내용은 HTML)과 11번가(PDF)를 같은 모양으로 바꾼다.
// 반환: { mall, source, items:[{name, spec, qty, amount, note}], shipping, stated }
// amount 는 항상 '실제 결제 금액'(할인 반영)만 쓴다.

export class ParseError extends Error {}

export const toInt = (v) => {
  const s = String(v ?? '').replace(/[^\d-]/g, '');
  return /\d/.test(s) ? parseInt(s, 10) : 0;
};

function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function cellText(el) {
  if (!el) return '';
  const parts = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) parts.push(c.nodeValue);
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function guessMall(html, fallback) {
  const auction = /옥션|auction/i.test(html);
  const gmarket = /지마켓|g마켓|gmarket/i.test(html);
  if (auction && !gmarket) return '옥션';
  if (gmarket && !auction) return '지마켓';
  return fallback;
}

// 상품 단위 할인을 옵션 금액 비율대로 나누고, 끝수는 마지막 옵션이 가져간다.
export function shareDiscount(prices, discount) {
  const base = prices.reduce((a, b) => a + b, 0);
  if (!discount || !base) return prices.map(() => 0);
  let used = 0;
  return prices.map((p, i) => {
    const cut = i === prices.length - 1 ? discount - used : Math.round((discount * p) / base);
    used += cut;
    return cut;
  });
}

// ---------------------------------------------------------------- 표(HTML) 공통

// rowspan/colspan 을 풀어서 모든 칸이 자기 셀을 가리키는 2차원 배열로 만든다.
function expandTable(table) {
  const grid = [];
  [...table.rows].forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c]) c++;
      const rs = cell.rowSpan || 1;
      const cs = cell.colSpan || 1;
      for (let i = 0; i < rs; i++) {
        grid[r + i] = grid[r + i] || [];
        for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
      }
      c += cs;
    }
  });
  return grid;
}

// 가장 안쪽에서 '공급합계'를 가진 표 (바깥 레이아웃 표를 잡지 않도록)
function findItemTable(doc, pickText) {
  const hits = [...doc.querySelectorAll('table')].filter((t) => pickText(t));
  return hits.find((t) => !hits.some((o) => o !== t && t.contains(o)));
}

// ---------------------------------------------------------------- 구형 양식

function readLegacy(doc, source, mall) {
  const table = findItemTable(doc, (t) => t.querySelector('thead')?.textContent.includes('공급합계'));
  if (!table) throw new ParseError('상품 표를 찾지 못했습니다.');

  const items = [];
  for (const tr of table.querySelectorAll('tbody > tr')) {
    const tds = [...tr.children].filter((e) => e.tagName === 'TD');
    if (!tds.length) continue;
    if (tds[0].classList.contains('first') && tds.length >= 7) {
      items.push({
        name: cellText(tds[1]),
        spec: '',
        note: cellText(tds[2]),
        qty: toInt(cellText(tds[3])),
        amount: toInt(cellText(tds[6])),
      });
    } else if (items.length) {
      const opt = cellText(tds[0]);
      const last = items[items.length - 1];
      if (opt && opt !== last.name && !last.spec.split(' + ').includes(opt)) {
        last.spec = last.spec ? `${last.spec} + ${opt}` : opt;
      }
    }
  }

  let shipping = 0;
  let stated = 0;
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.children].filter((e) => e.tagName === 'TD' || e.tagName === 'TH');
    if (cells.length < 2) continue;
    const key = cellText(cells[0]);
    if (key === '배송비') shipping = toInt(cellText(cells[1]));
    else if (key.includes('총 구매금액')) stated = toInt(cellText(cells[1]));
  }
  return { mall, source, items, shipping, stated };
}

// ---------------------------------------------------------------- 신형 양식

function readGrid(doc, source, mall) {
  const table = findItemTable(doc, (t) => t.textContent.includes('공급합계'));
  if (!table) throw new ParseError('상품 표를 찾지 못했습니다.');

  const grid = expandTable(table);
  const width = Math.max(0, ...grid.map((r) => (r ? r.length : 0)));
  const cells = grid.map((r) => Array.from({ length: width }, (_, c) => (r ? r[c] || null : null)));
  const text = cells.map((r) => r.map(cellText));

  const headRow = text.findIndex((r) => r.includes('공급합계'));
  if (headRow < 0) throw new ParseError('표 머리글을 찾지 못했습니다.');
  const head = text[headRow];
  const col = (...keys) => head.findIndex((t) => keys.some((k) => t.includes(k)));
  const cName = col('상품명');
  const cQty = col('수량');
  const cPrice = col('공급가격', '공급가액');
  const cDisc = col('할인금액');
  const cTotal = col('공급합계');
  const cSeller = col('공급자명');
  if ([cName, cQty, cPrice, cTotal].some((i) => i < 0)) {
    throw new ParseError('표 머리글을 해석하지 못했습니다.');
  }

  // 상품명 칸이 공급합계 칸까지 이어진 줄은 상품 제목줄이고, 그 아래 줄들이 옵션이다.
  const groups = [];
  for (let r = headRow + 1; r < text.length; r++) {
    const row = text[r];
    if (!row.some(Boolean)) continue;
    if (cells[r][cName] && cells[r][cName] === cells[r][cTotal]) {
      groups.push({ name: row[cName], seller: '', discount: 0, opts: [] });
      continue;
    }
    const g = groups[groups.length - 1];
    if (!g) continue;
    const qty = toInt(row[cQty]);
    const price = toInt(row[cPrice]);
    if (!qty && !price) continue;
    g.opts.push({ label: row[cName], qty, price });
    if (cSeller >= 0) g.seller = row[cSeller];
    if (cDisc >= 0) g.discount = Math.abs(toInt(row[cDisc]));
  }

  const items = [];
  for (const g of groups) {
    const cuts = shareDiscount(g.opts.map((o) => o.price), g.discount);
    g.opts.forEach((o, i) => {
      items.push({
        name: g.name,
        spec: o.label === '본품' || o.label === g.name ? '' : o.label,
        note: g.seller,
        qty: o.qty,
        amount: o.price - cuts[i],
      });
    });
  }

  let shipping = 0;
  let stated = 0;
  for (const li of doc.querySelectorAll('li.list-item')) {
    const label = cellText(li.querySelector('.text__label'));
    const value = cellText(li.querySelector('.text__value'));
    if (!label) continue;
    if (label.includes('배송비')) shipping = toInt(value);
    else if (label.includes('총 구매금액')) stated = toInt(value);
  }
  return { mall, source, items, shipping, stated };
}

// ---------------------------------------------------------------- 아이스크림몰

// 머리글이 td 이고, 상품명 칸에 <p>품명 [상품번호]</p><p>옵션 : …</p> 가 들어 있다.
// 배송비는 판매자 묶음마다 rowspan 으로 한 번만 적혀 있어 줄마다 더하면 중복되므로,
// 배송비와 총액은 위쪽 '최종견적금액' 줄에서 읽는다.
function readIscream(doc, source) {
  const table = findItemTable(doc, (t) => t.querySelector('thead')?.textContent.includes('1개당 금액'));
  if (!table) throw new ParseError('상품 표를 찾지 못했습니다.');

  const trs = [...table.rows];
  const grid = expandTable(table);
  const text = (r, c) => cellText(grid[r]?.[c]);

  const headRow = trs.findIndex((tr) => tr.parentElement.tagName === 'THEAD' && cellText(tr).includes('상품명'));
  if (headRow < 0) throw new ParseError('표 머리글을 찾지 못했습니다.');
  const head = (grid[headRow] || []).map(cellText);
  const cName = head.indexOf('상품명');
  const cQty = head.indexOf('수량');
  const cTotal = head.indexOf('합계금액');
  const cSeller = head.indexOf('판매자');
  if ([cName, cQty, cTotal].some((i) => i < 0)) throw new ParseError('표 머리글을 해석하지 못했습니다.');

  const items = [];
  trs.forEach((tr, r) => {
    if (r <= headRow || tr.parentElement.tagName !== 'TBODY') return;
    const nameCell = grid[r]?.[cName];
    if (!nameCell) return;
    const paras = nameCell.querySelectorAll('p');
    let title = cellText(paras[0] || nameCell);
    const code = /\s*\[\d+\]\s*$/.exec(title);
    if (code) title = title.slice(0, code.index).trim();
    let option = paras[1] ? cellText(paras[1]).replace(/^옵션\s*:\s*/, '') : '';
    if (/^단일상품/.test(option)) option = '';
    const qty = toInt(text(r, cQty));
    const amount = toInt(text(r, cTotal));
    if (!title || (!qty && !amount)) return;
    items.push({ name: title, spec: option, note: text(r, cSeller), qty, amount });
  });

  let shipping = 0;
  let stated = 0;
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.children];
    if (cells.length < 4 || cellText(cells[0]) !== '최종견적금액') continue;
    const tds = cells.filter((e) => e.tagName === 'TD');
    shipping = toInt(cellText(tds[1]));
    stated = toInt(cellText(tds[2]));
    break;
  }
  return { mall: '아이스크림몰', source, items, shipping, stated };
}

// ---------------------------------------------------------------- 11번가 PDF

const ROW = /^(\d+)\s+(\d{6,})\s+(.+?)\s+(\d+)\s+((?:[\d,]+원\s*){4})$/;
const STOP = /^(합계|배송비|총합계|https?:\/\/|No\b|수$|량$|판매가|\(할인전금액\))/;
const isCjk = (ch) => /[가-힣一-鿿]/.test(ch);

function joinWrapped(parts) {
  let out = '';
  for (const p of parts.filter(Boolean)) {
    if (!out) out = p;
    else if (isCjk(out.slice(-1)) && isCjk(p[0])) out += p;
    else out += ' ' + p;
  }
  return out;
}

// 줄 단위 텍스트에서 11번가 견적서를 읽는다. (PDF 추출과 분리해 두어 따로 시험할 수 있다)
export function sheetFromPdfLines(lines, source) {
  const items = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const full = joinWrapped(cur.parts);
    const cut = full.indexOf(' / ');
    items.push({
      name: (cut < 0 ? full : full.slice(0, cut)).trim(),
      spec: cut < 0 ? '' : full.slice(cut + 3).trim(),
      note: cur.no,
      qty: cur.qty,
      amount: cur.amount,
    });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    const m = ROW.exec(line);
    if (m) {
      close();
      const won = [...m[5].matchAll(/([\d,]+)원/g)].map((x) => toInt(x[1]));
      cur = { no: m[2], parts: [m[3].trim()], qty: parseInt(m[4], 10), amount: won[3] };
      continue;
    }
    if (!cur) continue;
    if (!line || STOP.test(line)) close();
    else cur.parts.push(line);
  }
  close();

  const all = lines.join('\n');
  let shipping = 0;
  const pre = /배송비\(선결제\)\s*([\d,]+)\s*원/.exec(all);
  const cod = /착불배송비\s*([\d,]+)\s*원/.exec(all);
  if (pre) shipping += toInt(pre[1]);
  if (cod) shipping += toInt(cod[1]);
  const total = /총합계\s*([\d,]+)\s*원/.exec(all);
  return { mall: '11번가', source, items, shipping, stated: total ? toInt(total[1]) : 0 };
}

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';

function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x: it.transform[4], w: it.width, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const p of row.parts) {
      if (end !== null && p.x - end > 1.5 && !out.endsWith(' ') && !p.s.startsWith(' ')) out += ' ';
      out += p.s;
      end = p.x + p.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  });
}

async function readPdf(buf, source) {
  const pdfjs = await import(PDFJS + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    lines.push(...itemsToLines((await page.getTextContent()).items));
  }
  const sheet = sheetFromPdfLines(lines, source);
  if (!sheet.items.length) throw new ParseError('11번가 견적서에서 상품 줄을 찾지 못했습니다.');
  return sheet;
}

// ---------------------------------------------------------------- 진입점

export async function parseFile(name, buf) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'pdf') return readPdf(buf, name);

  const html = decode(buf);
  const iscream = html.includes('1개당 금액') && html.includes('할인적용금액');
  if (!iscream && /11번가|십일번가/.test(html)) throw new ParseError('11번가 견적서는 PDF로 받아 주세요.');
  const doc = new DOMParser().parseFromString(html, 'text/html');

  if (iscream) return readIscream(doc, name);
  if (html.includes('table-data__value') || html.includes('list__estimate-summary')) {
    return readGrid(doc, name, guessMall(html, '옥션'));
  }
  if (html.includes('font-tahoma')) return readLegacy(doc, name, guessMall(html, '지마켓'));
  throw new ParseError('지원하지 않는 견적서 양식입니다.');
}
