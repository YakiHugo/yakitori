import Foundation

let tools: [[String: Any]] = [
    [
        "name": "control",
        "description": "Control real macOS apps. list returns apps, visible windows and active displays. launch accepts exactly one bundle_id, absolute app_path (.app), or exact app_name; it opens in the background and returns the resolved identity. observe supports mode=ax (Accessibility only, no screenshot or Screen Recording needed), vision (screenshot only), or both (default; AX when available). scope=window (default) requires pid/window_id; scope=app requires pid and composes all its visible windows; scope=screen accepts display_id, defaulting to the main display. Screen scope captures the entire selected display, including other apps. AX elements include their owning pid/window_id. Every input requires the latest snapshot_id and consumes it before delivery: observe again before another action. Coordinates are pixels of the returned image, across its full frame; AX-only observations accept element actions but no pixel coordinates. Choose an element or coordinates, never both. press performs AXPress; perform_action invokes a currently advertised action_name. set_value writes text through AXValue and reads it back. select_text selects a unique literal match (optional immediate prefix/suffix) or places the cursor before/after it; use a fresh observation before typing into that selection. click/scroll/drag use x/y. Background type/key require a confirmed target element. Background is default for window/app scope; screen input requires delivery=foreground (except element-based AX actions). Foreground uses the shared keyboard/mouse. key chords use CMD/CTRL/ALT/SHIFT, e.g. CMD+A or ENTER. dy/dx are signed scroll pixels. Input delivery is unverified: observe the result and never blindly retry a write. status reports OS permissions; permissions requests access for Yakitori Computer.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "action": ["type": "string", "enum": ["status", "permissions", "list", "launch", "observe", "press", "click", "type", "key", "scroll", "drag", "set_value", "select_text", "perform_action"]],
                "pid": ["type": "integer", "minimum": 1],
                "window_id": ["type": "integer", "minimum": 1],
                "bundle_id": ["type": "string"],
                "app_path": ["type": "string", "description": "Absolute application bundle path, e.g. /Applications/Safari.app."],
                "app_name": ["type": "string", "description": "Exact bundle/display name. Searches running apps and standard application directories; ambiguous names require app_path."],
                "mode": ["type": "string", "enum": ["ax", "vision", "both"], "default": "both"],
                "scope": ["type": "string", "enum": ["window", "app", "screen"], "default": "window"],
                "display_id": ["type": "integer", "minimum": 1],
                "snapshot_id": ["type": "string"],
                "element": ["type": "integer", "minimum": 0],
                "button": ["type": "string", "enum": ["left", "right", "middle"]],
                "click_count": ["type": "integer", "minimum": 1, "maximum": 3],
                "x": ["type": "number"], "y": ["type": "number"],
                "to_x": ["type": "number"], "to_y": ["type": "number"],
                "replace": ["type": "boolean", "description": "For type, requires an element with readable text and writable AX selection; confirms the full selection before typing replacement text."],
                "text": ["type": "string"], "key": ["type": "string"],
                "prefix": ["type": "string", "description": "Immediate text before a select_text match, to disambiguate repeated text."],
                "suffix": ["type": "string", "description": "Immediate text after a select_text match."],
                "selection_type": ["type": "string", "enum": ["text", "cursor_before", "cursor_after"]],
                "action_name": ["type": "string", "description": "For perform_action, an exact action advertised by the observed element."],
                "dx": ["type": "integer", "minimum": -2000, "maximum": 2000],
                "dy": ["type": "integer", "minimum": -2000, "maximum": 2000],
                "delivery": ["type": "string", "enum": ["background", "foreground"]],
            ],
            "required": ["action"], "additionalProperties": false,
        ],
    ],
    ["name": "turn_ended", "description": "Release the current turn's observations after all input has stopped.", "inputSchema": ["type": "object", "properties": [:], "additionalProperties": false]],
]
