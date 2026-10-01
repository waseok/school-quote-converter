// js/*.js (ES 모듈)을 app.bundle.js 한 파일(일반 스크립트)로 합친다.
// 크롬은 file:// 주소에서 모듈 스크립트를 막으므로, 더블클릭으로 열려면 일반 스크립트여야 한다.
// 소스를 고친 뒤에는 `node build.mjs` 를 다시 실행한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['parse.js', 'clean.js', 'export.js', 'app.js']; // 의존되는 파일이 먼저

const parts = ORDER.map((f) => {
  const src = fs.readFileSync(path.join(root, 'js', f), 'utf8');
  const body = src
    .replace(/^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${f}: import/export 가 남았습니다`);
  return `// ---- ${f}\n${body.trim()}\n`;
});

const out = `// build.mjs 로 만든 파일입니다. 직접 고치지 말고 js/ 아래 소스를 고친 뒤 다시 만드세요.\n(() => {\n'use strict';\n${parts.join('\n')}})();\n`;
fs.writeFileSync(path.join(root, 'app.bundle.js'), out);
console.log(`app.bundle.js ${Math.round(out.length / 1024)}KB`);
