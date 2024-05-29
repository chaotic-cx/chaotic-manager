import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

async function setup(): Promise<void> {
    const termdiv: HTMLElement | null = document.getElementById("terminal");
    if (!termdiv) {
        console.error("Terminal div not found");
        return;
    }

    const term: Terminal = new Terminal({
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
    const fitAddon: FitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termdiv);

    if ("ontouchstart" in window) {
        term.element!.addEventListener("focusin", (): void => {
            term.blur();
        });
        term.element!.addEventListener("focus", (): void => {
            term.blur();
        });
    }

    // Disable all key events
    term.attachCustomKeyEventHandler((): boolean => {
        return false;
    });

    const xterm_resize_ob: ResizeObserver = new ResizeObserver(function (): void {
        fitAddon.fit();
    });
    xterm_resize_ob.observe(termdiv);
    fitAddon.fit();

    // Parse querystring
    const query: URLSearchParams = new URLSearchParams(window.location.search);
    let id: string;

    // Print error if there is no ID
    if (!query.has("id") || !/^[a-zA-Z0-9-_]+$/.test((id = query.get("id") as string))) {
        document.title = "Chaotic logs: invalid ID";
        term.writeln("\x1B[1;3;31mID is invalid or no ID provided. Did you copy the querystring?\x1B[0m ");
        return;
    }

    let url: string = "api/logs/" + id;
    let timestamp: string;
    if (query.has("timestamp") && /^\d+$/.test((timestamp = query.get("timestamp") as string))) url += "/" + timestamp;

    let is_finished: boolean = false;
    await fetch(url).then(async (response: Response): Promise<void> => {
        document.title = `Chaotic logs: ${id} - ${timestamp}`;
        if (!response.body) {
            term.writeln("\x1B[1;3;31mError: No response body\x1B[0m ");
            is_finished = true;
            return;
        }
        const reader: ReadableStreamDefaultReader = response.body.getReader();
        let err: boolean = false;
        while (!is_finished && !err) {
            await reader
                .read()
                .then(({ done, value }): void => {
                    if (done) {
                        is_finished = true;
                    }
                    if (value) term.write(value);
                })
                .catch(() => {
                    err = true;
                });
        }
    });
}

void setup();
