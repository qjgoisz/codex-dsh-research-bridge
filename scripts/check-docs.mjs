// Lightweight offline checks for bilingual counterparts and repository links.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const roots = ['README', 'CONTRIBUTING', 'CHANGELOG', 'NOTICE'];
const enDir = join(root, 'docs', 'en'), zhDir = join(root, 'docs', 'zh-CN');
const names = dir => readdirSync(dir).filter(name => name.endsWith('.md')).sort();
const en = names(enDir), zh = names(zhDir), errors = [];
if (JSON.stringify(en) !== JSON.stringify(zh)) errors.push('English and Chinese docs must have matching filenames.');
const pairs = roots.map(name => [join(root, `${name}.md`), join(root, `${name}.zh-CN.md`)])
  .concat(en.map(name => [join(enDir,name),join(zhDir,name)]));
const withoutCode = text => text.replace(/```[\s\S]*?```/g, '');
function anchors(text) {
  const result = new Set(), seen = new Map();
  for (const match of withoutCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].replace(/<[^>]*>/g,'').replace(/[`*_]/g,'').toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu,'').trim().replace(/\s/g,'-');
    const number = seen.get(base) ?? 0; seen.set(base,number+1);
    result.add(number ? `${base}-${number}` : base);
  }
  return result;
}
const files = pairs.flat().concat(names(join(root,'docs')).map(name => join(root,'docs',name)));
let checkedLinks = 0;
for (const file of files) {
  if (!existsSync(file)) { errors.push(`Missing document: ${relative(root,file)}`); continue; }
  const text = withoutCode(readFileSync(file,'utf8'));
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1].split(' "')[0];
    if (/^[a-zA-Z][\w+.-]*:/.test(href)) continue;
    const [pathname,fragment] = href.split('#');
    let target, anchor;
    try { target = pathname ? resolve(file,'..',decodeURIComponent(pathname)) : file;
      anchor = fragment ? decodeURIComponent(fragment) : ''; }
    catch { errors.push(`Invalid link in ${relative(root,file)}: ${href}`); continue; }
    checkedLinks++;
    if (!existsSync(target)) { errors.push(`Broken link in ${relative(root,file)}: ${href}`); continue; }
    if (anchor && extname(target)==='.md' && !anchors(readFileSync(target,'utf8')).has(anchor)) {
      errors.push(`Missing heading in ${relative(root,file)}: ${href}`);
    }
  }
}
for (const [first,second] of pairs) {
  if (!existsSync(first) || !existsSync(second)) continue;
  for (const [file,other] of [[first,second],[second,first]]) {
    const href = relative(resolve(file,'..'),other).replaceAll('\\','/');
    const text = readFileSync(file,'utf8');
    if (!text.includes(`](${href})`)) errors.push(`Missing language switch in ${relative(root,file)}: ${href}`);
  }
}
if (errors.length) { for (const error of errors) process.stderr.write(error+'\n'); process.exitCode=1; }
else console.log(`Documentation verified: ${pairs.length} bilingual pairs, ${checkedLinks} local links.`);
