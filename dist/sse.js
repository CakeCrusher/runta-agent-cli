// Server-sent events become one JSON object per line: {"event", "id", "data"} with data parsed when it is JSON.
export async function* readEvents(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
            const ev = parse(raw);
            if (ev)
                yield ev;
        }
    }
    const tail = parse(buffer);
    if (tail)
        yield tail;
}
function parse(raw) {
    const ev = { event: "message", id: undefined, data: [] };
    let seen = false;
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":"))
            continue; // comments are keep-alives
        const i = line.indexOf(":");
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "data")
            ev.data.push(value);
        else if (field === "event")
            ev.event = value;
        else if (field === "id")
            ev.id = value;
        else
            continue;
        seen = true;
    }
    if (!seen)
        return null;
    const text = ev.data.join("\n");
    let data = text;
    try {
        data = JSON.parse(text);
    }
    catch {
        // keep the raw string
    }
    return { event: ev.event, id: ev.id, data };
}
//# sourceMappingURL=sse.js.map