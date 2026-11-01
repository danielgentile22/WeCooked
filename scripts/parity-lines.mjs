#!/usr/bin/env node
// Re-points the line numbers in docs/PARITY.md cells after code moves.
// A cell reference is `path:line Label`. When the label is a symbol
// (`name` or `Type.member`), the cited line no longer mentions the member,
// and the member is declared exactly once in
// the file, the line is rewritten to the declaration. Anything else is left
// alone and listed, so a human (or /parity-audit) can fix it.
//
//   node scripts/parity-lines.mjs          rewrite in place, print changes
//   node scripts/parity-lines.mjs --check  print only, exit 1 if anything moved
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const doc = 'docs/PARITY.md';
const check = process.argv.includes('--check');
const text = readFileSync(doc, 'utf8');
const files = new Map();
const lines = (path) => {
	if (!files.has(path)) files.set(path, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null);
	return files.get(path);
};
const decl = (name) =>
	new RegExp(
		`\\b(func|var|let|const|function|class|struct|enum|protocol|extension|case|snippet)\\s+${name}\\b`
	);

let moved = 0;
const unresolved = new Set();
const out = text.replace(/`([\w./[\]+-]+\.(?:swift|svelte|ts)):(\d+) ([^`]+)`/g, (whole, path, n, label) => {
	const src = lines(path);
	if (!src) return (unresolved.add(`${path} (missing file)`), whole);
	// Only symbol labels (`name` or `Type.member`); prose labels are skipped.
	if (!/^[\w.]+$/.test(label)) return whole;
	const name = label.split('.').pop();
	if ((src[Number(n) - 1] ?? '').includes(name)) return whole;
	const hits = src.flatMap((l, i) => (decl(name).test(l) ? [i + 1] : []));
	if (hits.length !== 1) return (unresolved.add(`${path}:${n} ${label}`), whole);
	moved++;
	console.log(`${path}:${n} -> ${hits[0]} ${label}`);
	return `\`${path}:${hits[0]} ${label}\``;
});

for (const u of unresolved) console.log(`unresolved: ${u}`);
if (check) process.exit(moved ? 1 : 0);
if (moved) writeFileSync(doc, out);
