// Design: docs/bladeburner.md
// @ts-check
/**
 * Stanek's Gift: whether it can still be accepted, and whether joining Bladeburner would close it. The one place that
 * knows the rules (bitburner-src v3.0.0, src/CotMG/Helper.tsx and src/PersonObjects/Player/PlayerObjectBladeburnerMethods.ts):
 *   - the Church of the Machine God is open in BitNode 13, and anywhere once you own Source-File 13;
 *   - the Gift can be accepted only while every augmentation installed or bought is NeuroFlux Governor;
 *   - joining the Bladeburner division with Source-File 7 at level 3 installs The Blade's Simulacrum at once,
 *     which closes the Gift for the rest of the BitNode (the game warns about this when you join by hand; the API doesn't).
 * Pure, 0GB: pass getResetInfo(). It sees installed augmentations only (bought ones need the Singularity API), so an
 * augmentation bought but not installed already closes the Gift without this knowing until the install.
 */
export const GIFT = "Stanek's Gift - Genesis";
const NEUROFLUX = "NeuroFlux Governor";

/**
 * @typedef {{ currentNode: number, ownedSF: Map<number, number>, ownedAugs?: Map<string, number> }} GiftInfo
 * the parts of getResetInfo() these read
 */

/**
 * True while this run can still accept the Gift, as far as the installed augmentations tell. False once it is
 * accepted (the Gift is then installed), once any other augmentation is installed, or without the church.
 * @param {GiftInfo} info
 * @returns {boolean}
 */
export function giftOpen(info) {
	const church = info.currentNode === 13 || (info.ownedSF.get(13) ?? 0) > 0;
	return church && [...(info.ownedAugs?.keys() ?? [])].every((aug) => aug === NEUROFLUX);
}

/**
 * True when joining Bladeburner now would install The Blade's Simulacrum and so close a Gift that is still open.
 * @param {GiftInfo} info
 * @returns {boolean}
 */
export function joiningClosesGift(info) {
	return (info.ownedSF.get(7) ?? 0) >= 3 && giftOpen(info);
}
