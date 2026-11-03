import { describe, expect, it } from 'vitest';
import { tickSender } from './ticks';

// A fake PATCH per call, held until the test answers it.
function harness() {
	const outbox: Record<string, boolean> = {};
	const calls: { id: string; ticked: boolean; answer: (ok: boolean) => void; done?: true }[] = [];
	const flush = tickSender(
		() => outbox,
		(id, ticked) => new Promise<boolean>((answer) => calls.push({ id, ticked, answer })),
		(id, ticked) => {
			if (outbox[id] === ticked) delete outbox[id];
		}
	);
	const inFlight = () => calls.filter((c) => !c.done).map((c) => `${c.id}:${c.ticked}`);
	const answer = async (i: number, ok = true) => {
		calls[i].answer(ok);
		calls[i].done = true;
		await new Promise((r) => setTimeout(r, 0));
	};
	return { outbox, calls, flush, inFlight, answer };
}

describe('tick sends (issue #75, as iOS ShoppingModel.flush)', () => {
	it('sends ticks on different lines at once', async () => {
		const h = harness();
		h.outbox.a = true;
		h.outbox.b = true;
		const flushed = h.flush();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.inFlight().sort()).toEqual(['a:true', 'b:true']);
		await h.answer(0);
		await h.answer(1);
		await flushed;
		expect(h.outbox).toEqual({});
	});

	it('keeps one send per line; a tap during it goes out when it lands', async () => {
		const h = harness();
		h.outbox.a = true;
		const first = h.flush();
		await new Promise((r) => setTimeout(r, 0));
		h.outbox.a = false;
		const second = h.flush();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.inFlight()).toEqual(['a:true']);
		await h.answer(0);
		expect(h.inFlight()).toEqual(['a:false']);
		await h.answer(1);
		await Promise.all([first, second]);
		expect(h.outbox).toEqual({});
	});

	it('a failed line stays queued and the others carry on', async () => {
		const h = harness();
		h.outbox.a = true;
		h.outbox.b = true;
		const flushed = h.flush();
		await new Promise((r) => setTimeout(r, 0));
		await h.answer(0, false);
		await h.answer(1);
		await flushed;
		expect(h.outbox).toEqual({ a: true });
	});
});
