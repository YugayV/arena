#!/usr/bin/env node
/**
 * Статические проверки сайта.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Запуск: node tools/test_site.mjs
 *
 * Ловит класс ошибок, который браузер показывает молча: пропущенный
 * перевод выводится как ключ, обращение к несуществующему элементу даёт
 * null и роняет обработчик только при нажатии, а забытая ссылка на
 * удалённый файл — пустое место на странице.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'site/index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'site/app.js'), 'utf8');
const i18nSrc = readFileSync(join(ROOT, 'site/i18n.js'), 'utf8');
const chart = readFileSync(join(ROOT, 'site/chart.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' ПРОВАЛ '} ${name}${detail ? ': ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/* ------------------------------------------------------------------ словарь */

// i18n.js — обычный скрипт, поэтому вычисляем его в песочнице и берём I18N
const sandbox = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
new Function('window', 'document', i18nSrc + '\nwindow.__I18N = I18N;')
  (sandbox.window, sandbox.document);
const dict = sandbox.window.__I18N;

const ru = new Set(Object.keys(dict.ru));
const en = new Set(Object.keys(dict.en));

const onlyRu = [...ru].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !ru.has(k));
check('словари ru и en совпадают по ключам', !onlyRu.length && !onlyEn.length,
  onlyRu.length || onlyEn.length ? `только ru: ${onlyRu}, только en: ${onlyEn}` : `${ru.size} ключей`);

// ключи, использованные в разметке
const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
// и в коде: t('ключ', lang) или сокращение L('ключ')
for (const m of app.matchAll(/\b[tL]\('([a-z0-9.]+)'/gi)) used.add(m[1]);

const missing = [...used].filter((k) => !ru.has(k));
check('все использованные ключи есть в словаре', !missing.length,
  missing.length ? missing.join(', ') : `${used.size} использовано`);

// ключ может стоять и внутри выражения — L(reg ? 'auth.register' : 'auth.login'),
// поэтому мёртвым считаем тот, что не упомянут нигде вообще
const dead = [...ru].filter((k) => !used.has(k) && !app.includes(`'${k}'`));
check('в словаре нет мёртвых ключей', !dead.length,
  dead.length ? dead.join(', ') : 'лишних нет');

/* ------------------------------------------------------- элементы страницы */

const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
// часть разметки код рисует сам — такие id тоже настоящие
for (const m of app.matchAll(/\bid="([^"${]+)"/g)) ids.add(m[1]);

const wanted = new Set();
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) wanted.add(m[1]);
// в chart.js обращения идут напрямую
for (const m of chart.matchAll(/getElementById\('([^']+)'\)/g)) wanted.add(m[1]);

const noSuchId = [...wanted].filter((k) => !ids.has(k));
check('все элементы, к которым обращается код, есть в разметке', !noSuchId.length,
  noSuchId.length ? noSuchId.join(', ') : `${wanted.size} проверено`);

/* -------------------------------------------------------------- подключения */

const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
let filesOk = true;
for (const f of [...scripts, ...styles]) {
  try { readFileSync(join(ROOT, 'site', f)); } catch { filesOk = false; console.log('    нет файла:', f); }
}
check('все подключённые файлы существуют', filesOk, [...scripts, ...styles].join(', '));

/* ------------------------------------------------------------- вкладки */

const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const pages = [...html.matchAll(/id="page-([^"]+)"/g)].map((m) => m[1]);
const pagesConst = (app.match(/const PAGES = \[([^\]]+)\]/) || [])[1] || '';
const declared = pagesConst.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

check('у каждой вкладки есть своя страница',
  tabs.every((t) => pages.includes(t)),
  tabs.filter((t) => !pages.includes(t)).join(', ') || tabs.join(', '));
check('список страниц в коде совпадает с разметкой',
  pages.every((p) => declared.includes(p)) && declared.every((p) => pages.includes(p)),
  `разметка: ${pages.join(',')} | код: ${declared.join(',')}`);

const goTargets = [...html.matchAll(/data-go="([^"]+)"/g)].map((m) => m[1]);
check('все ссылки data-go ведут на существующие страницы',
  goTargets.every((t) => pages.includes(t)),
  [...new Set(goTargets)].join(', '));

/* ---------------------------------------------------- удалённый виджет */

const leftovers = ['tvHost', 'loadTv', 'tvSymbol', 'tradingview.com', 'TradingView'];
const found = leftovers.filter((s) => html.includes(s) || app.includes(s) || i18nSrc.includes(s));
check('следов виджета TradingView не осталось', !found.length, found.join(', ') || 'чисто');

/* ------------------------------------------------------- внешние ресурсы */

// ссылка <a href> уводит по клику и это нормально; проверяем то, что браузер
// грузит сам: скрипты, стили, картинки, шрифты, фреймы
const external = [
  ...[...html.matchAll(/\bsrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
];
check('страница не тянет ничего извне', !external.length,
  external.length ? external.join(', ') : 'подгружаемых извне ресурсов нет');

console.log(`\nитого: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
