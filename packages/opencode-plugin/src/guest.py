"""Bounded remote file operations. Inputs arrive as JSON, never as shell fragments."""
import json
import os
import stat
import tempfile
import sys
import subprocess

MAX_BYTES = 1024 * 1024

def read(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Not a regular file")
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("File exceeds 1 MiB; use shell for a bounded slice")
    return data.decode("utf-8")

def write(path, content):
    path = os.path.realpath(path)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".createos-", dir=parent)
    try:
        if os.path.exists(path):
            os.fchmod(fd, stat.S_IMODE(os.stat(path).st_mode))
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def patch(document):
    lines = document.splitlines()
    if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
        raise ValueError("Expected Begin/End Patch envelope")
    changes = []
    i = 1
    while i < len(lines) - 1:
        header = lines[i]
        i += 1
        if header.startswith("*** Add File: "):
            path = header[14:]
            if os.path.lexists(path):
                raise ValueError("Add target already exists: " + path)
            body = []
            while i < len(lines) - 1 and not lines[i].startswith("*** "):
                if not lines[i].startswith("+"):
                    raise ValueError("Add lines must start with +")
                body.append(lines[i][1:])
                i += 1
            changes.append((path, None, "\n".join(body) + "\n"))
        elif header.startswith("*** Delete File: "):
            path = header[17:]
            read(path)
            changes.append((path, path, None))
        elif header.startswith("*** Update File: "):
            path = header[17:]
            target = path
            original = read(path)
            content = original
            if lines[i].startswith("*** Move to: "):
                target = lines[i][13:]
                if os.path.lexists(target):
                    raise ValueError("Move target already exists")
                i += 1
            while i < len(lines) - 1 and not lines[i].startswith("*** "):
                if not lines[i].startswith("@@"):
                    raise ValueError("Expected patch hunk")
                i += 1
                old, new = [], []
                while i < len(lines) - 1 and not lines[i].startswith(("@@", "*** ")):
                    line = lines[i]
                    if not line or line[0] not in " +-":
                        raise ValueError("Invalid hunk line")
                    if line[0] in " -": old.append(line[1:])
                    if line[0] in " +": new.append(line[1:])
                    i += 1
                source = content.splitlines()
                positions = [position for position in range(len(source) + 1) if old and source[position:position + len(old)] == old]
                if len(positions) != 1:
                    raise ValueError("Patch context must match exactly once: " + path)
                position = positions[0]
                source[position:position + len(old)] = new
                content = "\n".join(source) + ("\n" if content.endswith("\n") else "")
                if i < len(lines) and lines[i] == "*** End of File": i += 1
            changes.append((target, path if target != path else None, content))
        else:
            raise ValueError("Unknown patch header: " + header)
    paths = [os.path.realpath(item[0]) for item in changes]
    if len(paths) != len(set(paths)):
        raise ValueError("A patch may target each file only once")
    # Validate all hunks before the first mutation; each individual write is atomic.
    for target, remove, content in changes:
        if content is not None: write(target, content)
        if remove is not None: os.unlink(remove)
    return {"files": [item[0] for item in changes]}

def main(data):
    os.chdir(data["cwd"])
    op, args = data["op"], data["args"]
    path = args.get("path", args.get("filePath", "."))
    if op == "read":
        if os.path.isdir(path): return "\n".join(sorted(os.listdir(path))[:2000])
        lines = read(path).splitlines()
        offset = max(0, int(args.get("offset", 1)) - 1)
        limit = min(2000, max(1, int(args.get("limit", 2000))))
        return "\n".join(f"{i + 1}: {line}" for i, line in enumerate(lines[offset:offset+limit], offset))
    if op == "write":
        write(path, args["content"])
        return {"written": path}
    if op == "edit":
        content = read(path)
        old, new = args["oldString"], args["newString"]
        count = content.count(old)
        if not old or count == 0 or (count != 1 and not args.get("replaceAll", False)):
            raise ValueError("Edit must match exactly once unless replaceAll is true")
        write(path, content.replace(old, new, -1 if args.get("replaceAll") else 1))
        return {"edited": path, "matches": count}
    if op == "patch": return patch(args.get("patchText", args.get("patch", "")))
    if op in ("glob", "grep"):
        limit = min(2000, max(1, int(args.get("limit", 100))))
        pattern = args["pattern"]
        command = ["rg", "--color=never"]
        if op == "glob":
            command += ["--files", "--glob", pattern]
            if args.get("hidden", False): command += ["--hidden"]
            command += ["--", path]
        else:
            command += ["--line-number", "--no-heading", "--max-columns", "2000"]
            if args.get("literal"): command += ["--fixed-strings"]
            if not args.get("caseSensitive", True): command += ["--ignore-case"]
            if args.get("include"): command += ["--glob", args["include"]]
            command += ["--", pattern, path]
        matches = []
        # Drain errors to disk while bounding returned output, avoiding pipe deadlocks.
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
            limited = False
            try:
                for line in process.stdout:
                    matches.append(line.decode("utf-8", errors="replace").rstrip("\n").removeprefix("./"))
                    if len(matches) >= limit:
                        limited = True
                        process.terminate()
                        break
                status = process.wait()
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
            if not limited and status not in (0, 1):
                errors.seek(0)
                raise ValueError(errors.read(8192).decode("utf-8", errors="replace"))
        return "\n".join(matches) if matches else "No matches found"
    raise ValueError("Unsupported remote operation: " + op)

try:
    print(json.dumps({"result": main(json.load(sys.stdin))}))
except Exception as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(1)
