import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

async function setup() {
    var termdiv = document.getElementById('terminal');
    if (!termdiv) {
        console.error("Terminal div not found");
        return;
    }

    var term = new Terminal({ scrollback: 9999999, disableStdin: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termdiv);

    if ('ontouchstart' in window) {
        term.element!.addEventListener('focusin', () => {
            term.blur();
        });
        term.element!.addEventListener('focus', () => {
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
    var query = new URLSearchParams(window.location.search);

    var id: string;
    // Print error if there is no ID 
    if (!query.has('id') || !/^[a-zA-Z0-9-_]+$/.test(id = query.get("id") as string)) {
        term.writeln('\x1B[1;3;31mID is invalid or no ID provided. Did you copy the querystring?\x1B[0m ')
        return;
    }

    var url = "api/logs/" + id;
    var timestamp: string;
    if (query.has("timestamp") && /^\d+$/.test(timestamp = query.get("timestamp") as string))
        url += "/" + timestamp;

    var is_finishd = false;
    await fetch(url).then(async (response) => {
        if (!response.body) {
            term.writeln('\x1B[1;3;31mError: No response body\x1B[0m ');
            is_finishd = true;
            return;
        }
        const reader = response.body.getReader();
        var err = false;
        while (!is_finishd && !err) {
            await reader.read().then(({ done, value }) => {
                if (done) {
                    is_finishd = true;
                }
                if (value)
                    term.write(value);
            }).catch((e) => {
                err = true;
            });
        }
    });
}

setup();