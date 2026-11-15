// @ts-check
// The karma a gang needs. Its own file so scripts that only need the number (sleeves/sleeve-manager.js) don't pay for the Gang API
// calls in utils/gang.js, which re-exports it.

/** The karma a gang needs (0 in BitNode 2, where the invite is all it takes; else -54,000), from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number }} info */
export function karmaNeededFromInfo(info) {
	return info.currentNode === 2 ? 0 : -54_000;
}
