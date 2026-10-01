import { parseFile } from './parse.js';
import { tidy } from './clean.js';
import { MALLS, orderedSheets, summarize, unitPrice, flatRows, saveGoods, savePumui } from './export.js';

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
