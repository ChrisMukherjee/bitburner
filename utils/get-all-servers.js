/** @param {NS} ns **/
// Get all reachable servers using Depth-First Search.
// Bought (cloud) servers are linked to home, so the scan finds them too.
export function getAllServers(ns) {
	let visited = new Set();
	let servers = ["home"];

	// Traverse the scanned network graph
	while (servers.length > 0) {
		let server = servers.pop();
		if (!visited.has(server)) {
			visited.add(server);
			let neighbors = ns.scan(server);
			for (let neighbor of neighbors) {
				if (!visited.has(neighbor)) servers.push(neighbor);
			}
		}
	}

	return Array.from(visited);
}
