// Design: docs/aug-reset.md
// @ts-check
/**
 * The augmentation price step: each augmentation bought and not yet installed multiplies the price of every other
 * one (NeuroFlux Governor included) by 1.9, or by less with Source-File 11: x0.96, x0.94 and x0.93 of that at levels
 * 1 to 3, so 1.824, 1.786 and 1.767. The game reads the active level only, so BitNode 11 itself gives no discount
 * until it has been destroyed once (bitburner-src v3.0.0, src/Augmentation/AugmentationHelpers.ts).
 * Pure, 0GB: the caller passes getResetInfo().ownedSF, which holds the active levels.
 */
export const BASE_PRICE_STEP = 1.9;
const SF11_DISCOUNT = [1, 0.96, 0.94, 0.93];

/**
 * The price step for this run.
 * @param {Map<number, number> | null | undefined} ownedSF Source-File number -> active level (getResetInfo().ownedSF)
 * @returns {number}
 */
export function augPriceStep(ownedSF) {
	const level = Math.max(0, Math.min(3, ownedSF?.get(11) ?? 0));
	return BASE_PRICE_STEP * SF11_DISCOUNT[level];
}
