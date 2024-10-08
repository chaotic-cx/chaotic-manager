import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
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

    const webglAddon: WebglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
        webglAddon.dispose();
    });
    term.loadAddon(webglAddon);

    term.open(termdiv);

    const viewPort = document.getElementsByClassName("xterm-viewport")[0] as HTMLElement;
    viewPort.setAttribute("style", "background-color: #1e1e2e; scrollbar-color: #f5e0dc #1e1e2e");

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

    const xterm_resize_ob: ResizeObserver = new ResizeObserver((): void => {
        fitAddon.fit();
    });
    xterm_resize_ob.observe(termdiv);
    fitAddon.fit();

    // Parse querystring
    const query: URLSearchParams = new URLSearchParams(window.location.search);

    // Print error if there is no ID
    if (!query.has("id")) {
        document.title = "Chaotic logs: invalid ID";
        term.writeln("\x1B[1;3;31mNo ID provided. Did you copy the querystring?\x1B[0m ");
        return;
    }

    let id: string = query.get("id") as string;
    let timestamp: string | null = query.get("timestamp");

    let url: URL = new URL("api/logs", window.location.href);
    url.pathname += `/${id}`;
    if (timestamp) url.pathname += `/${timestamp}`;

    let is_finished = false;
    await fetch(url).then(async (response: Response): Promise<void> => {
        document.title = `Chaotic logs: ${id}`;
        if (timestamp) document.title += `- ${timestamp}`;
        if (!response.body) {
            term.writeln("\x1B[1;3;31mError: No response body\x1B[0m ");
            is_finished = true;
            return;
        }
        const reader: ReadableStreamDefaultReader = response.body.getReader();
        let err = false;
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
