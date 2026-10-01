// 표 만들기와 에듀파인 업로드용 엑셀 저장. 엑셀 변환은 SheetJS(window.XLSX)를 쓴다.

export const MALLS = ['지마켓', '옥션', '11번가', '아이스크림몰'];

const rank = (mall) => {
  const i = MALLS.indexOf(mall);
  return i < 0 ? MALLS.length : i;
};

export const orderedSheets = (sheets) => [...sheets].sort((a, b) => rank(a.mall) - rank(b.mall));

export function summarize(sheet) {
  const goods = sheet.items.reduce((a, it) => a + it.amount, 0);
  const total = goods + sheet.shipping;
  return { goods, total, ok: !sheet.stated || total === sheet.stated };
}

// 단가 = 금액 ÷ 수량. 나누어떨어지지 않으면 소수 둘째 자리까지.
export function unitPrice(amount, qty) {
  if (!qty) return 0;
  const u = amount / qty;
  return Number.isInteger(u) ? u : Math.round(u * 100) / 100;
}

// 품의용 예상단가: 에듀파인이 예상금액을 단가×수량으로 다시 계산하므로, 소수 셋째 자리에서 올려
// 단가×수량이 실결제 금액 이상이 되게 한다. (정수 연산으로 올림해 부동소수 오차를 피한다)
export function ceilUnitPrice(amount, qty) {
  if (!qty) return 0;
  return Math.ceil((amount * 100) / qty) / 100;
}

// 몰별로 상품 줄 다음에 배송비 줄을 붙인 평평한 목록
export function flatRows(sheets) {
  const rows = [];
  for (const s of orderedSheets(sheets)) {
    for (const it of s.items) rows.push({ name: it.name, qty: it.qty, amount: it.amount });
    if (s.shipping) rows.push({ name: `${s.mall} 배송비`, qty: 1, amount: s.shipping });
  }
  return rows;
}

export const GOODS_HEADER = ['품명', '규격', '수량', '단위', '예상단가', '예상금액', '용도'];
export const PUMUI_HEADER = ['내용', '규격', '단위', '수량', '예상단가'];

// 규격 칸에는 옵션 문구 대신 모든 줄에 공백 한 칸을 넣는다.
// 규격 열이 통째로 비면 에듀파인이 서식을 못 읽는다고 해서, 보이지는 않지만 비어 있지도 않게 한다.
export const SPEC_FILL = ' ';

export const goodsAoa = (rows) => [
  GOODS_HEADER,
  ...rows.map((r) => [r.name, SPEC_FILL, r.qty, '개', unitPrice(r.amount, r.qty), r.amount, '']),
];

export const pumuiAoa = (rows) => [
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
export const saveGoods = (rows) => save(goodsAoa(rows), '물품내역', [44, 30, 7, 6, 11, 13, 16], [4, 5], '물품내역');
export const savePumui = (rows) => save(pumuiAoa(rows), '품목내역', [44, 30, 7, 6, 12], [4], '품목내역');
