import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

async function setup() {
    const termdiv = document.getElementById("terminal");
    if (!termdiv) {
        console.error("Terminal div not found");
        return;
    }

    const term = new Terminal({
        disableStdin: true,
        scrollback: 9999999,
        theme: {
            background: "#1e1e2e",
            black: "#45475a",
            blue: "#89b4fa",
            brightBlack: "#585b70",
            brightBlue: "#89b4fa",
            brightCyan: "#94e2d5",
            brightGreen: "#a6e3a1",
            brightMagenta: "#f5c2e7",
            brightRed: "#f38ba8",
            brightWhite: "#a6adc8",
            brightYellow: "#f9e2af",
            cursor: "#f5e0dc",
            cursorAccent: "#f5e0dc",
            cyan: "#94e2d5",
            foreground: "#cdd6f4",
            green: "#a6e3a1",
            magenta: "#f5c2e7",
            red: "#f38ba8",
            white: "#bac2de",
            yellow: "#f9e2af",
        },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termdiv);

    if ("ontouchstart" in window) {
        term.element!.addEventListener("focusin", () => {
            term.blur();
        });
        term.element!.addEventListener("focus", () => {
            term.blur();
        });
    }

    // Disable all key events
    term.attachCustomKeyEventHandler(() => {
        return false;
    });

    const xterm_resize_ob = new ResizeObserver(function (entries) {
        fitAddon.fit();
    });
    xterm_resize_ob.observe(termdiv);
    fitAddon.fit();

    // Parse querystring
    const query = new URLSearchParams(window.location.search);

    let id: string;
    // Print error if there is no ID
    if (!query.has("id") || !/^[a-zA-Z0-9-_]+$/.test((id = query.get("id") as string))) {
        term.writeln("\x1B[1;3;31mID is invalid or no ID provided. Did you copy the querystring?\x1B[0m ");
        return;
    }

    let url = "api/logs/" + id;
    let timestamp: string;
    if (query.has("timestamp") && /^\d+$/.test((timestamp = query.get("timestamp") as string))) url += "/" + timestamp;

    let is_finished = false;
    await fetch(url).then(async (response) => {
        if (!response.body) {
            term.writeln("\x1B[1;3;31mError: No response body\x1B[0m ");
            is_finished = true;
            return;
        }
        const reader = response.body.getReader();
        let err = false;
        while (!is_finished && !err) {
            await reader
                .read()
                .then(({ done, value }) => {
                    if (done) {
                        is_finished = true;
                    }
                    if (value) term.write(value);
                })
                .catch((e) => {
                    err = true;
                });
        }
    });
}

setup();
