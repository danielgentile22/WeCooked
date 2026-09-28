// D16 app icon: the pot-with-steam glyph from the cooking-screen prototype,
// white on the saffron accent, exported at 180/192/512 plus a maskable 512.
// Run once (node scripts/make-icons.mjs); outputs are committed in static/.
import sharp from 'sharp';

// Glyph is drawn in a 24-unit box (prototype SVG). `scale` sets how much of
// the tile it fills: maskable keeps the art inside the central safe zone.
const tile = (scale) => {
	const art = 24 * scale;
	const off = (512 - art) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
	<rect width="512" height="512" fill="#b45309"/>
	<g transform="translate(${off} ${off}) scale(${scale})" fill="none" stroke="#fff"
		stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
		<path d="M4.5 12h15v3.5a5.5 5.5 0 0 1-5.5 5.5h-4a5.5 5.5 0 0 1-5.5-5.5V12z"/>
		<path d="M2.5 12h19"/>
		<path d="M8 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
		<path d="M12 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
		<path d="M16 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
	</g>
</svg>`;
};

const jobs = [
	['static/icon-180.png', tile(16), 180],
	['static/icon-192.png', tile(16), 192],
	['static/icon-512.png', tile(16), 512],
	['static/icon-maskable-512.png', tile(12.5), 512]
];
for (const [out, svg, size] of jobs) {
	await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
	console.log(out);
}
