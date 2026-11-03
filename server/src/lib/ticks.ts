/**
 * The shopping tick sender (issue #75), as iOS ShoppingModel.flush: every
 * line with a queued tick and no send in flight starts one, so ticks on
 * several lines go out together. A line has one send at a time: a tap on it
 * during its send goes out when that one lands, neither lost nor raced. A
 * failure ends that line's send and leaves its tick queued for the next
 * poll; other lines carry on.
 *
 * `pending` is the outbox of target states; `send` is one PATCH, true when
 * stored; `settled` runs after each stored send and is where the caller
 * clears the outbox entry if no newer tap replaced it. The returned flush
 * resolves once no send is in flight.
 */
export function tickSender(
	pending: () => Record<string, boolean>,
	send: (id: string, ticked: boolean) => Promise<boolean>,
	settled: (id: string, ticked: boolean) => void
): () => Promise<void> {
	const sending = new Map<string, Promise<void>>();
	async function line(id: string, first: boolean) {
		let ticked = first;
		try {
			while (await send(id, ticked)) {
				settled(id, ticked);
				const next = pending()[id];
				if (next === undefined || next === ticked) break;
				ticked = next;
			}
		} finally {
			sending.delete(id);
		}
	}
	return async () => {
		for (const [id, ticked] of Object.entries(pending()))
			if (!sending.has(id)) sending.set(id, line(id, ticked));
		while (sending.size) await sending.values().next().value;
	};
}
