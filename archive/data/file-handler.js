/** @param {NS} ns */
export class FileHandler {
	#file;
	#ns;

	constructor(ns, file) {
		this.#ns = ns;
		this.#file = file;
	}

	async newFile() {
		await this.#ns.write(this.#file, "", "w");
	}

	async write(data, mode = "a") {
		await this.#ns.write(this.#file, JSON.stringify(data), mode);
	}

	async read() {
		let dataString = await this.#ns.read(this.#file);
		if (dataString.length > 1) {
			return JSON.parse(dataString);
		} else {
			return [];
		}
	}
}