// Shared constants for the contract scripts. No ns calls, so importing this costs no RAM.

/** The solver writes "server:file" here for each wrong answer; solve-contracts.js moves them into FAILED_FILE. */
export const CONTRACT_PORT = 32;

/** "server:file" keys the solver got wrong, one per line, kept on home. These are never tried again. */
export const FAILED_FILE = "data/failed-contracts.txt";
