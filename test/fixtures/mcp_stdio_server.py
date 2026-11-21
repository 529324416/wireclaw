"""Wireclaw MCP stdio 测试服务器（NDJSON over stdin/stdout）。仅用于测试。"""

from __future__ import annotations

import json
import platform
import sys

TOOLS = [
    {
        "name": "echo",
        "description": "回显文本",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "stdio_env",
        "description": "返回 Python 版本与进程信息",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
]


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def text(content: str) -> list[dict[str, str]]:
    return [{"type": "text", "text": content}]


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not isinstance(message, dict) or "id" not in message:
            continue

        request_id = message["id"]
        method = message.get("method")

        if method == "initialize":
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "wireclaw-stdio-mcp", "version": "0.1.0"},
                },
            })
            continue

        if method == "ping":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            continue

        if method == "tools/list":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
            continue

        if method == "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            arguments = params.get("arguments") or {}

            if name == "echo":
                result = {"content": text(f"stdio echo: {arguments.get('text', '')}")}
            elif name == "stdio_env":
                result = {"content": text(
                    f"Python {platform.python_version()} on {platform.system()} {platform.machine()}"
                )}
            else:
                result = {"content": text(f"unknown tool: {name}"), "isError": True}

            send({"jsonrpc": "2.0", "id": request_id, "result": result})
            continue

        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        })


if __name__ == "__main__":
    main()
