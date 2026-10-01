// build.mjs 로 만든 파일입니다. 직접 고치지 말고 js/ 아래 소스를 고친 뒤 다시 만드세요.
(() => {
'use strict';
// ---- parse.js
// 견적서 읽기: 지마켓·옥션(.xls 확장자지만 내용은 HTML)과 11번가(PDF)를 같은 모양으로 바꾼다.
// 반환: { mall, source, items:[{name, spec, qty, amount, note}], shipping, stated }
// amount 는 항상 '실제 결제 금액'(할인 반영)만 쓴다.

class ParseError extends Error {}

const toInt = (v) => {
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
function shareDiscount(prices, discount) {
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
function sheetFromPdfLines(lines, source) {
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

async function parseFile(name, buf) {
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

// ---- clean.js
// 품명·규격 정리 (규칙 기반). 원문에 없는 정보는 만들지 않고, 군더더기만 덜어낸다.

const squeeze = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const OPTION_NO = /^\s*\d{1,3}(?:-\d{1,3})?\)\s*/;           // "01) ", "2-1) "
const PICK_GROUP = /\(\s*\d+\s*~\s*\d+\s*\)\s*선택\s*\/\s*/;    // "(1~3) 선택 / "
const LEADING_NO = /^\s*\d{1,2}[.)]?\s+/;                      // "3. ", "12 "
const PACK = /[xX]\s*(\d+)\s*(묶음|개입|세트|팩)/;
const PROMO_TAG = /\[(?:무료배송|당일발송|당일출고|특가|할인|이벤트|최저가|사은품)[^\]]*\]/g;
const SYMBOLS = /[★☆♥♡◆■●▶]+/g;
const LIST_WORDS = ['모음', '세트', '선택', '종류', '외', '인기', '베스트', '추천'];

function looksLikeKeywordList(name) {
  return name.split(' ').length >= 8 && LIST_WORDS.some((w) => name.includes(w));
}

// 검색 노출용으로 상품명이 나열식이고 실제 구매품은 옵션에만 있는 경우, 옵션에서 품명을 꺼낸다.
function fromOption(spec) {
  let head = spec.split(' + ').pop().replace(LEADING_NO, '').trim();
  if (!head) return null;

  let pack = '';
  const m = PACK.exec(head);
  if (m) {
    pack = m[1] + m[2];
    head = head.replace(PACK, '').trim();
  }
  const p = /^([^(]{1,20}?)\s*\((.+)\)\s*$/.exec(head);
  const name = p ? p[1].trim() : head;
  const detail = [p ? p[2].trim() : '', pack].filter(Boolean).join(', ');
  return name ? { name, spec: detail } : null;
}

function tidy(rawName, rawSpec) {
  const name = squeeze(String(rawName ?? '').replace(PROMO_TAG, ' ').replace(SYMBOLS, ' '));
  let spec = squeeze(rawSpec);

  const hadPick = PICK_GROUP.test(spec);
  spec = spec.replace(PICK_GROUP, '');
  spec = spec
    .split(' + ')
    .map((s) => s.replace(OPTION_NO, '').trim())
    .filter(Boolean)
    .join(' + ');

  if (name && spec.startsWith(name)) spec = spec.slice(name.length).replace(/^[\s/+]+/, '');

  if (spec && hadPick && looksLikeKeywordList(name)) {
    const picked = fromOption(spec);
    if (picked) return picked;
  }
  return { name, spec };
}

// ---- export.js
// 표 만들기와 에듀파인 업로드용 엑셀 저장. 엑셀 변환은 SheetJS(window.XLSX)를 쓴다.

const MALLS = ['지마켓', '옥션', '11번가', '아이스크림몰'];

const rank = (mall) => {
  const i = MALLS.indexOf(mall);
  return i < 0 ? MALLS.length : i;
};

const orderedSheets = (sheets) => [...sheets].sort((a, b) => rank(a.mall) - rank(b.mall));

function summarize(sheet) {
  const goods = sheet.items.reduce((a, it) => a + it.amount, 0);
  const total = goods + sheet.shipping;
  return { goods, total, ok: !sheet.stated || total === sheet.stated };
}

// 단가 = 금액 ÷ 수량. 나누어떨어지지 않으면 소수 둘째 자리까지.
function unitPrice(amount, qty) {
  if (!qty) return 0;
  const u = amount / qty;
  return Number.isInteger(u) ? u : Math.round(u * 100) / 100;
}

// 품의용 예상단가: 에듀파인이 예상금액을 단가×수량으로 다시 계산하므로, 소수 셋째 자리에서 올려
// 단가×수량이 실결제 금액 이상이 되게 한다. (정수 연산으로 올림해 부동소수 오차를 피한다)
function ceilUnitPrice(amount, qty) {
  if (!qty) return 0;
  return Math.ceil((amount * 100) / qty) / 100;
}

// 몰별로 상품 줄 다음에 배송비 줄을 붙인 평평한 목록
function flatRows(sheets) {
  const rows = [];
  for (const s of orderedSheets(sheets)) {
    for (const it of s.items) rows.push({ name: it.name, qty: it.qty, amount: it.amount });
    if (s.shipping) rows.push({ name: `${s.mall} 배송비`, qty: 1, amount: s.shipping });
  }
  return rows;
}

const GOODS_HEADER = ['품명', '규격', '수량', '단위', '예상단가', '예상금액', '용도'];
const PUMUI_HEADER = ['내용', '규격', '단위', '수량', '예상단가'];

// 규격 칸에는 옵션 문구 대신 모든 줄에 공백 한 칸을 넣는다.
// 규격 열이 통째로 비면 에듀파인이 서식을 못 읽는다고 해서, 보이지는 않지만 비어 있지도 않게 한다.
const SPEC_FILL = ' ';

const goodsAoa = (rows) => [
  GOODS_HEADER,
  ...rows.map((r) => [r.name, SPEC_FILL, r.qty, '개', unitPrice(r.amount, r.qty), r.amount, '']),
];

const pumuiAoa = (rows) => [
  PUMUI_HEADER,
  ...rows.map((r) => [r.name, SPEC_FILL, '개', r.qty, ceilUnitPrice(r.amount, r.qty)]),
];

function save(aoa, sheetName, widths, moneyCols, prefix) {
  const X = window.XLSX;
  if (!X) throw new Error('엑셀 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  const ws = X.utils.aoa_to_sheet(aoa);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  for (let r = 1; r < aoa.length; r++) {
    for (const c of moneyCols) {
      const cell = ws[X.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') cell.z = Number.isInteger(cell.v) ? '#,##0' : '#,##0.00';
    }
  }
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, sheetName);

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  X.writeFile(wb, `${prefix}_${stamp}.xlsx`);
}

// 에듀파인은 시트 이름이 서식과 같아야 인식한다.
const saveGoods = (rows) => save(goodsAoa(rows), '물품내역', [44, 30, 7, 6, 11, 13, 16], [4, 5], '물품내역');
const savePumui = (rows) => save(pumuiAoa(rows), '품목내역', [44, 30, 7, 6, 12], [4], '품목내역');

// ---- app.js
const $ = (id) => document.getElementById(id);
const entries = [];
let seq = 0;

// 파일 이름·상품명은 외부 데이터이므로 innerHTML 대신 DOM 으로 만든다.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const won = (n) => Number(n).toLocaleString('ko-KR');
const sheets = () => entries.filter((e) => e.sheet).map((e) => e.sheet);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function addFiles(list) {
  for (const file of list) {
    const entry = { id: ++seq, name: file.name, sheet: null, error: '', busy: true };
    entries.push(entry);
    render();
    try {
      const sheet = await parseFile(file.name, await file.arrayBuffer());
      for (const it of sheet.items) {
        it.rawName = it.name;
        it.rawSpec = it.spec;
        Object.assign(it, tidy(it.name, it.spec));
      }
      entry.sheet = sheet;
    } catch (err) {
      entry.error = err.message || String(err);
    }
    entry.busy = false;
    render();
  }
}

function removeEntry(id) {
  const i = entries.findIndex((e) => e.id === id);
  if (i >= 0) entries.splice(i, 1);
  render();
}

function fileCard(entry) {
  const status = entry.busy
    ? h('span', { class: 'muted' }, '읽는 중…')
    : entry.error
      ? h('span', { class: 'bad' }, entry.error)
      : h('span', { class: 'muted' }, `상품 ${entry.sheet.items.length}건`);

  const mallSel = entry.sheet
    ? h(
        'select',
        {
          'aria-label': '몰',
          onchange: (e) => {
            entry.sheet.mall = e.target.value;
            render();
          },
        },
        MALLS.map((m) => h('option', { value: m, selected: m === entry.sheet.mall }, m)),
      )
    : null;

  return h(
    'li',
    { class: 'file' },
    h('span', { class: 'fname' }, entry.name),
    mallSel,
    status,
    h('button', { class: 'link', type: 'button', onclick: () => removeEntry(entry.id) }, '제거'),
  );
}

function summaryTable() {
  const rows = orderedSheets(sheets()).map((s) => {
    const { goods, total, ok } = summarize(s);
    return h(
      'tr',
      {},
      h('td', { class: 'l' }, s.mall),
      h('td', { class: 'l' }, s.source),
      h('td', {}, String(s.items.length)),
      h('td', {}, won(goods)),
      h('td', {}, won(s.shipping)),
      h('td', {}, won(total)),
      h('td', {}, s.stated ? won(s.stated) : '-'),
      h('td', { class: ok ? 'ok' : 'bad' }, ok ? '일치' : '불일치'),
    );
  });
  return h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ['몰', '파일', '항목', '상품금액', '배송비', '합계', '견적서 총액', '검증'].map((t, i) =>
          h('th', { class: i < 2 ? 'l' : '' }, t),
        ),
      ),
    ),
    h('tbody', {}, rows),
  );
}

function itemTable() {
  const field = (it, key, raw) =>
    h('input', {
      type: 'text',
      value: it[key],
      title: raw ? `원본: ${raw}` : '',
      oninput: (e) => {
        it[key] = e.target.value;
      },
    });

  const body = [];
  for (const s of orderedSheets(sheets())) {
    for (const it of s.items) {
      body.push(
        h(
          'tr',
          {},
          h('td', { class: 'l mall' }, s.mall),
          h('td', { class: 'l' }, field(it, 'name', it.rawName)),
          h('td', {}, String(it.qty)),
          h('td', {}, won(unitPrice(it.amount, it.qty))),
          h('td', {}, won(it.amount)),
        ),
      );
    }
    if (s.shipping) {
      body.push(
        h(
          'tr',
          { class: 'ship' },
          h('td', { class: 'l mall' }, s.mall),
          h('td', { class: 'l' }, `${s.mall} 배송비`),
          h('td', {}, '1'),
          h('td', {}, won(s.shipping)),
          h('td', {}, won(s.shipping)),
        ),
      );
    }
  }
  return h(
    'table',
    { class: 'items' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ['몰', '품명', '수량', '단가', '금액'].map((t, i) => h('th', { class: i < 2 ? 'l' : '' }, t)),
      ),
    ),
    h('tbody', {}, body),
  );
}

function render() {
  $('files').replaceChildren(...entries.map(fileCard));

  const ready = sheets().some((s) => s.items.length);
  $('results').classList.toggle('hidden', !ready);
  if (!ready) return;
  $('summary').replaceChildren(summaryTable());
  $('item-table').replaceChildren(itemTable());
}

function download(saver) {
  try {
    saver(flatRows(sheets()));
  } catch (err) {
    toast(err.message);
  }
}

const drop = $('drop');
const input = $('file');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    input.click();
  }
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('hover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('hover');
  addFiles([...e.dataTransfer.files]);
});
input.addEventListener('change', () => {
  addFiles([...input.files]);
  input.value = '';
});
$('dl-goods').addEventListener('click', () => download(saveGoods));
$('dl-pumui').addEventListener('click', () => download(savePumui));
$('clear').addEventListener('click', () => {
  entries.length = 0;
  render();
});

render();
})();
