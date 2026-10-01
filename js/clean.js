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

export function tidy(rawName, rawSpec) {
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
