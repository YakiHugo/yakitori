import Foundation

let tools: [[String: Any]] = [
    [
        "name": "control",
        "description": "Control real macOS apps. Use list to discover pid/window_id, then observe that exact window for a screenshot and indexed accessibility elements. Every input requires the latest snapshot_id and consumes it, including a refused input: observe again before another action. Coordinates are pixels of that screenshot. press performs AXPress on an element; click/scroll/drag use x/y pixels; Background type and key require a target element with confirmed keyboard focus; foreground can address the current focus of a canvas window. key chords use CMD/CTRL/ALT/SHIFT, e.g. CMD+A or ENTER. dy/dx are signed scroll pixels. Background delivery is the default and does not automatically activate an app. delivery=foreground explicitly activates the target and uses the shared keyboard/mouse. Input delivery is unverified: observe the resulting app state; never blindly retry a write. Use CLI/MCP integrations alongside this tool when useful. status reports OS permissions; permissions requests human approval for Yakitori Computer. launch opens bundle_id in the background.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "action": ["type": "string", "enum": ["status", "permissions", "list", "launch", "observe", "press", "click", "type", "key", "scroll", "drag"]],
                "pid": ["type": "integer", "minimum": 1],
                "window_id": ["type": "integer", "minimum": 1],
                "bundle_id": ["type": "string"],
                "snapshot_id": ["type": "string"],
                "element": ["type": "integer", "minimum": 0],
                "button": ["type": "string", "enum": ["left", "right", "middle"]],
                "click_count": ["type": "integer", "minimum": 1, "maximum": 3],
                "x": ["type": "number"], "y": ["type": "number"],
                "to_x": ["type": "number"], "to_y": ["type": "number"],
                "replace": ["type": "boolean", "description": "For type, select all in the confirmed field before typing."],
                "text": ["type": "string"], "key": ["type": "string"],
                "dx": ["type": "integer", "minimum": -2000, "maximum": 2000],
                "dy": ["type": "integer", "minimum": -2000, "maximum": 2000],
                "delivery": ["type": "string", "enum": ["background", "foreground"]],
            ],
            "required": ["action"], "additionalProperties": false,
        ],
    ],
    ["name": "turn_ended", "description": "Release the current turn's observations after all input has stopped.", "inputSchema": ["type": "object", "properties": [:], "additionalProperties": false]],
]
