import assert from 'node:assert/strict';
import { shareDiscount, sheetFromPdfLines, toInt } from '../js/parse.js';
import { tidy } from '../js/clean.js';
import { ceilUnitPrice, unitPrice, flatRows, summarize, goodsAoa, pumuiAoa } from '../js/export.js';

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log('ok -', name);
};

t('toInt: 쉼표·원 제거, 음수 유지, 빈 값은 0', () => {
  assert.equal(toInt('1,234원'), 1234);
  assert.equal(toInt('-500'), -500);
  assert.equal(toInt(''), 0);
  assert.equal(toInt('-'), 0);
  assert.equal(toInt(undefined), 0);
});

t('shareDiscount: 비례 배분, 합이 정확히 할인액', () => {
  const cuts = shareDiscount([1000, 2000, 3000], 1000);
  assert.equal(cuts.reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(cuts, [167, 333, 500]);
  assert.deepEqual(shareDiscount([500, 500], 0), [0, 0]);
  assert.deepEqual(shareDiscount([0, 0], 100), [0, 0]);
});

t('tidy: 옵션 번호 제거', () => {
  assert.deepEqual(tidy('볼펜', '01) 블랙 + 02) 0.5mm'), { name: '볼펜', spec: '블랙 + 0.5mm' });
});

t('tidy: 규격이 품명으로 시작하면 품명 부분을 뗀다', () => {
  assert.deepEqual(tidy('A4 용지', 'A4 용지 / 500매'), { name: 'A4 용지', spec: '500매' });
  assert.deepEqual(tidy('A4 용지', 'A4 용지 + 500매'), { name: 'A4 용지', spec: '500매' });
});

t('tidy: 홍보 태그·기호 제거, 값은 보존', () => {
  assert.deepEqual(tidy('[무료배송] ★모나미 네임펜★ M', ''), { name: '모나미 네임펜 M', spec: '' });
});

t('tidy: 나열식 상품명은 선택 옵션에서 품명을 꺼낸다', () => {
  const name = '학생용품 문구 모음전 인기 베스트 추천 볼펜 화일 가위 풀 테이프 세트';
  const out = tidy(name, '(1~3) 선택 / 1) 가위 + 2. 모나미 네임펜M(블랙) x2묶음');
  assert.deepEqual(out, { name: '모나미 네임펜M', spec: '블랙, 2묶음' });
});

t('tidy: 나열식이 아니면 건드리지 않는다', () => {
  assert.deepEqual(tidy('3M 테이프 522D', '(1~3) 선택 / 01) 18mm'), { name: '3M 테이프 522D', spec: '18mm' });
});

t('단가: 나누어떨어지면 정수, 아니면 소수 둘째 자리', () => {
  assert.equal(unitPrice(3000, 3), 1000);
  assert.equal(unitPrice(1000, 3), 333.33);
  assert.equal(unitPrice(1000, 0), 0);
});

t('품의용 단가 올림: 단가×수량 >= 금액, 부동소수 오차 없음', () => {
  assert.equal(ceilUnitPrice(1000, 3), 333.34);
  assert.equal(ceilUnitPrice(1100, 10), 110);
  assert.equal(ceilUnitPrice(110, 100), 1.1);
  assert.equal(ceilUnitPrice(115, 100), 1.15);
  for (const [a, q] of [[999, 7], [12345, 13], [50, 3], [7, 9]]) {
    assert.ok(ceilUnitPrice(a, q) * q >= a - 1e-9, `${a}/${q}`);
  }
});

const PDF_LINES = [
  '견적서',
  'No 상품번호 상품명 수 판매가 할인 합계',
  '1 1234567890 모나미 네임펜 M / 블랙 2 1,000원 0원 0원 2,000원',
  '2 9876543210 아주 긴 상품 이름이 두 줄로 나뉘어 3 5,000원 500원 0원 13,500원',
  '서 표시됩니다 / 파란색',
  '합계 15,500원',
  '배송비(선결제) 3,000원',
  '총합계 18,500원',
];
t('11번가 줄 파싱: 항목·줄바꿈 이어붙이기·배송비·총합계', () => {
  const s = sheetFromPdfLines(PDF_LINES, 'x.pdf');
  assert.equal(s.mall, '11번가');
  assert.equal(s.items.length, 2);
  assert.deepEqual(s.items[0], { name: '모나미 네임펜 M', spec: '블랙', note: '1234567890', qty: 2, amount: 2000 });
  assert.equal(s.items[1].name, '아주 긴 상품 이름이 두 줄로 나뉘어서 표시됩니다');
  assert.equal(s.items[1].spec, '파란색');
  assert.equal(s.items[1].amount, 13500);
  assert.equal(s.shipping, 3000);
  assert.equal(s.stated, 18500);
  const { total, ok } = summarize(s);
  assert.equal(total, 18500);
  assert.equal(ok, true);
  assert.equal(summarize({ ...s, stated: 18000 }).ok, false);
  assert.equal(summarize({ ...s, stated: 0 }).ok, true); // 견적서 총액을 못 읽었으면 검증 생략
});

t('flatRows: 몰 순서(지마켓→옥션→11번가), 배송비 줄', () => {
  const mk = (mall, amount, shipping) => ({ mall, source: mall, items: [{ name: mall, spec: '', qty: 1, amount }], shipping, stated: 0 });
  const rows = flatRows([mk('11번가', 1, 0), mk('옥션', 2, 2500), mk('지마켓', 3, 0)]);
  assert.deepEqual(rows.map((r) => r.name), ['지마켓', '옥션', '옥션 배송비', '11번가']);
});

t('엑셀 행: 물품내역·품목내역 열 구성', () => {
  const rows = [{ name: '볼펜', spec: '블랙', qty: 3, amount: 1000 }];
  assert.deepEqual(goodsAoa(rows)[1], ['볼펜', ' ', 3, '개', 333.33, 1000, '']);
  assert.deepEqual(pumuiAoa(rows)[1], ['볼펜', ' ', '개', 3, 333.34]);
  assert.deepEqual(goodsAoa(rows)[0], ['품명', '규격', '수량', '단위', '예상단가', '예상금액', '용도']);
  assert.deepEqual(pumuiAoa(rows)[0], ['내용', '규격', '단위', '수량', '예상단가']);
});

console.log(`\n${n} tests passed`);
