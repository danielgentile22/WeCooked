// Set the TestFlight "What to Test" notes on one build, through the App Store
// Connect API with the key named in server/.env (the same key the archive uses).
//
//   node scripts/testflight-notes.mjs <build number> <notes file>
//
// Waits for the build to finish processing (up to 20 minutes), then creates or
// updates its en-US beta build localization.

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [buildNumber, notesPath] = process.argv.slice(2);
if (!buildNumber || !notesPath) {
	console.error('usage: node scripts/testflight-notes.mjs <build number> <notes file>');
	process.exit(2);
}
process.loadEnvFile(fileURLToPath(new URL('../server/.env', import.meta.url)));
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = process.env;
const BUNDLE_ID = 'kitchen.wecooked.ios';
const API = 'https://api.appstoreconnect.apple.com/v1';

const b64 = (s) => Buffer.from(s).toString('base64url');
function token() {
	const now = Math.floor(Date.now() / 1000);
	const header = b64(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
	const payload = b64(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
	const key = createPrivateKey(readFileSync(ASC_KEY_PATH.replace(/^~/, process.env.HOME)));
	const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
	return `${header}.${payload}.${sig.toString('base64url')}`;
}

async function call(method, path, body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
		body: body && JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

const apps = await call('GET', `/apps?filter[bundleId]=${BUNDLE_ID}`);
const appId = apps.data[0]?.id;
if (!appId) throw new Error(`No app with bundle id ${BUNDLE_ID}`);

let build;
for (let i = 0; i < 80; i++) {
	const r = await call('GET', `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&sort=-uploadedDate&limit=1`);
	build = r.data[0];
	const state = build?.attributes.processingState;
	if (state === 'VALID') break;
	if (state === 'FAILED' || state === 'INVALID') throw new Error(`Build ${buildNumber} is ${state}`);
	console.log(`build ${buildNumber}: ${state ?? 'not uploaded yet'}, waiting`);
	await new Promise((r) => setTimeout(r, 15_000));
}
if (build?.attributes.processingState !== 'VALID') throw new Error(`Build ${buildNumber} never became VALID`);

const whatsNew = readFileSync(notesPath, 'utf8').trim();
const existing = await call('GET', `/builds/${build.id}/betaBuildLocalizations`);
const enUS = existing.data.find((l) => l.attributes.locale === 'en-US');
if (enUS) {
	await call('PATCH', `/betaBuildLocalizations/${enUS.id}`, {
		data: { type: 'betaBuildLocalizations', id: enUS.id, attributes: { whatsNew } }
	});
} else {
	await call('POST', '/betaBuildLocalizations', {
		data: {
			type: 'betaBuildLocalizations',
			attributes: { locale: 'en-US', whatsNew },
			relationships: { build: { data: { type: 'builds', id: build.id } } }
		}
	});
}
console.log(`build ${buildNumber} (${build.id}): notes set`);
