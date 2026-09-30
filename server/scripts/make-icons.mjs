// D16 app icon: the pot-with-steam glyph from the cooking-screen prototype,
// white on the saffron accent, exported at 180/192/512 plus a maskable 512,
// and the iOS app icon (light, dark, tinted) and launch glyph.
// Run once from server/ (node scripts/make-icons.mjs); outputs are committed
// in static/ and ../WeCooked/Assets.xcassets/.
import sharp from 'sharp';

const accentLight = '#b45309';
const accentDark = '#f59e0b';
const ios = '../WeCooked/Assets.xcassets';

// Glyph is drawn in a 24-unit box (prototype SVG) on a 512 canvas. `scale`
// sets how much of the canvas it fills: maskable keeps the art inside the
// central safe zone. No `fill` leaves the background transparent.
const tile = (scale, { stroke = '#fff', fill = accentLight } = {}) => {
	const art = 24 * scale;
	const off = (512 - art) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${
		fill ? `\n\t<rect width="512" height="512" fill="${fill}"/>` : ''
	}
	<g transform="translate(${off} ${off}) scale(${scale})" fill="none" stroke="${stroke}"
		stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
		<path d="M4.5 12h15v3.5a5.5 5.5 0 0 1-5.5 5.5h-4a5.5 5.5 0 0 1-5.5-5.5V12z"/>
		<path d="M2.5 12h19"/>
		<path d="M8 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
		<path d="M12 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
		<path d="M16 8.5c0-1.3 1-1.6 1-2.7 0-.5-.2-1-.6-1.4"/>
	</g>
</svg>`;
};

const pwa = [
	['static/icon-180.png', tile(16), 180],
	['static/icon-192.png', tile(16), 192],
	['static/icon-512.png', tile(16), 512],
	['static/icon-maskable-512.png', tile(12.5), 512]
];
for (const [out, svg, size] of pwa) {
	await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
	console.log(out);
}

// iOS draws its own backdrop behind the dark and tinted icons, and tints the
// grey one itself. The launch glyph fills its canvas: the 40 pt image set is
// the whole mark.
const edge = 512 / 24;
const launch = (stroke) => tile(edge, { stroke, fill: null });
const native = [
	[`${ios}/AppIcon.appiconset/icon-light.png`, tile(16), 1024, true],
	[`${ios}/AppIcon.appiconset/icon-dark.png`, tile(16, { stroke: accentDark, fill: null }), 1024],
	[`${ios}/AppIcon.appiconset/icon-tinted.png`, tile(16, { stroke: '#d0d0d0', fill: null }), 1024],
	...[1, 2, 3].flatMap((x) => [
		[`${ios}/LaunchGlyph.imageset/glyph-light@${x}x.png`, launch(accentLight), 40 * x],
		[`${ios}/LaunchGlyph.imageset/glyph-dark@${x}x.png`, launch(accentDark), 40 * x]
	])
];
// App Store Connect rejects an app icon with an alpha channel.
for (const [out, svg, size, opaque] of native) {
	// Rasterize at the target size instead of upscaling the 512 canvas.
	const image = sharp(Buffer.from(svg), { density: (72 * size) / 512 }).resize(size, size);
	await (opaque ? image.removeAlpha() : image).png().toFile(out);
	console.log(out);
}
