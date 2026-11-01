#!/usr/bin/env node
// Re-points the line numbers in docs/PARITY.md cells after code moves.
// A cell reference is `path:line Label`. When the label is a symbol
// (`name` or `Type.member`), the cited line no longer mentions the member,
// and the member is declared exactly once in
// the file, the line is rewritten to the declaration. Anything else is left
// alone and listed, so a human (or /parity-audit) can fix it.
//
// With `--since <rev>`, every reference into a file changed since <rev> is
// first carried through the diff (prose labels too), and a reference to a
// deleted line is listed.
//
//   node scripts/parity-lines.mjs                  rewrite in place, print changes
//   node scripts/parity-lines.mjs --since HEAD     same, after carrying lines through edits
//   node scripts/parity-lines.mjs --check          print only, exit 1 if anything moved
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const doc = 'docs/PARITY.md';
const check = process.argv.includes('--check');
const sinceAt = process.argv.indexOf('--since');
const since = sinceAt > 0 ? process.argv[sinceAt + 1] : null;

// Old line -> new line for one file, from `git diff -U0 <since> -- path`.
// Returns null for an unchanged file and undefined for a deleted line.
const maps = new Map();
function carry(path, old) {
	if (!since) return old;
	if (!maps.has(path)) {
		const diff = execFileSync('git', ['diff', '-U0', since, '--', path], { encoding: 'utf8' });
		const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
			o: +m[1], oc: m[2] === undefined ? 1 : +m[2], n: +m[3], nc: m[4] === undefined ? 1 : +m[4]
		}));
		maps.set(path, hunks.length ? hunks : null);
	}
	const hunks = maps.get(path);
	if (!hunks) return old;
	let shift = 0;
	for (const h of hunks) {
		const start = h.oc === 0 ? h.o + 1 : h.o;
		if (old < start) break;
		if (old < start + h.oc) return undefined;
		shift += h.nc - h.oc;
	}
	return old + shift;
}
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
	const carried = carry(path, Number(n));
	if (carried === undefined) return (unresolved.add(`${path}:${n} ${label} (line edited)`), whole);
	if (carried !== Number(n)) {
		moved++;
		console.log(`${path}:${n} -> ${carried} ${label}`);
		whole = `\`${path}:${carried} ${label}\``;
		n = String(carried);
	}
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
