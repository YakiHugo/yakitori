// A Runtime-role Input whose text equals this directive triggers a
// compaction-only Turn: the runner folds all uncovered completed Turns into a
// checkpoint instead of making a regular model call. Shared by the server
// (compact endpoint), the runner (dispatch), and the GUI (composer shortcut).
export const COMPACT_DIRECTIVE = "/compact"

// GUI-local composer directive: "/goal <text>" sets the session goal, a bare
// "/goal" opens the goal editor. Never admitted as an Input.
export const GOAL_DIRECTIVE = "/goal"
