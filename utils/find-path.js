/** @param {NS} ns **/
// Breadth-First Search to find the exact route from 'home'
export function findPath(ns, target) {
	let visited = new Set();
	let queue = [["home"]];

	while (queue.length > 0) {
		let path = queue.shift();
		let node = path[path.length - 1];

		if (node === target) return path;

		if (!visited.has(node)) {
			visited.add(node);
			for (let neighbor of ns.scan(node)) {
				if (!visited.has(neighbor)) {
					queue.push([...path, neighbor]);
				}
			}
		}
	}
	return [];
}