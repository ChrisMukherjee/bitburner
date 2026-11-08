// Picks the university course for singularity/player-work.js and player-work-start.js. Plain data, 0GB.
// Design: docs/player-work.md

/** Class names the game reports for the running work (current.classType), by course. */
const CLASS_NAMES = {
	"Study Computer Science": "STUDYCOMPUTERSCIENCE",
	"Computer Science": "STUDYCOMPUTERSCIENCE",
	"Data Structures": "DATASTRUCTURES",
	"Networks": "NETWORKS",
	"Algorithms": "ALGORITHMS",
};

/**
 * The course to take now: the paid one (`studying.paidCourse`, e.g. "Algorithms", several times the exp of the free
 * course) once cash covers `studying.paidSeconds` of its fee (`studying.paidPerSecond`), else the free one.
 * An empty paidCourse keeps the free course always.
 */
export function pickCourse(studying, money) {
	const { paidCourse, paidPerSecond = 960, paidSeconds = 600 } = studying;
	return paidCourse && money >= paidPerSecond * paidSeconds ? paidCourse : studying.course;
}

/** True when the running class is the given course. */
export function isCourse(current, course) {
	return current?.type === "CLASS" && String(current.classType ?? "").toUpperCase() === (CLASS_NAMES[course] ?? "");
}
