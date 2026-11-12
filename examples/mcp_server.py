"""Rotom MCP 测试服务器（Python + Flask）。

运行：
    pip install flask
    python examples/mcp_server.py
    # 自定义端口
    MCP_PORT=5001 python examples/mcp_server.py

协议：
    JSON-RPC 2.0 over HTTP POST /mcp
    MCP 2025-06-18（简化版 Streamable HTTP，直接返回 application/json）

工具：
    echo             只读，回显文本
    add              只读，数字相加
    python_env       只读，返回 Python 版本 / 平台 / PID
    write_temp_file  破坏性，写入系统临时目录（Rotom 侧会触发审批）
    divide           只读，除零时返回 isError
"""

from __future__ import annotations

import os
import platform
import tempfile
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "rotom-python-mcp"
SERVER_VERSION = "0.1.0"

TEMP_DIR = (Path(tempfile.gettempdir()) / "rotom-mcp-example").resolve()
TEMP_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

TOOLS: list[dict[str, Any]] = [
    {
        "name": "echo",
        "title": "Echo",
        "description": "回显传入的文本",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "要回显的文本"}},
            "required": ["text"],
        },
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "add",
        "title": "Add",
        "description": "计算两个数字的和",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "第一个加数"},
                "b": {"type": "number", "description": "第二个加数"},
            },
            "required": ["a", "b"],
        },
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "python_env",
        "title": "Python Environment",
        "description": "返回运行本服务器的 Python 版本、平台与进程 ID，用于验证跨语言调用",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True, "idempotentHint": True},
    },
    {
        "name": "write_temp_file",
        "title": "Write Temp File",
        "description": "在系统临时目录写入一个文本文件（破坏性操作，需要审批）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "文件名，默认 note.txt"},
                "content": {"type": "string", "description": "写入内容"},
            },
            "required": ["content"],
        },
        "annotations": {"destructiveHint": True, "idempotentHint": False},
    },
    {
        "name": "divide",
        "title": "Divide",
        "description": "计算 a / b；除数为 0 时返回 isError",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number"},
                "b": {"type": "number"},
            },
            "required": ["a", "b"],
        },
        "annotations": {"readOnlyHint": True},
    },
]


def text(content: str) -> list[dict[str, str]]:
    return [{"type": "text", "text": content}]


def ok(tool_result: dict[str, Any]) -> dict[str, Any]:
    return tool_result


def tool_error(message: str) -> dict[str, Any]:
    return {"content": text(message), "isError": True}


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "echo":
        return ok({"content": text(f"echo: {arguments.get('text', '')}")})

    if name == "add":
        a = arguments.get("a")
        b = arguments.get("b")
        if not is_number(a) or not is_number(b):
            return tool_error("add 需要数字参数 a 和 b")
        total = a + b
        return ok({
            "content": text(f"{a} + {b} = {total}"),
            "structuredContent": {"sum": total},
        })

    if name == "python_env":
        return ok({
            "content": text(
                f"Python {platform.python_version()} on {platform.system()} "
                f"{platform.machine()} (pid={os.getpid()})"
            ),
            "structuredContent": {
                "python": platform.python_version(),
                "system": platform.system(),
                "machine": platform.machine(),
                "pid": os.getpid(),
            },
        })

    if name == "write_temp_file":
        content = arguments.get("content")
        if not isinstance(content, str):
            return tool_error("write_temp_file 需要字符串参数 content")

        raw_name = arguments.get("name", "note.txt")
        relative_name = str(raw_name).replace("\\", "/")
        target = (TEMP_DIR / relative_name).resolve()

        if target != TEMP_DIR and TEMP_DIR not in target.parents:
            return tool_error("拒绝写入临时目录之外的路径")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        size = len(content.encode("utf-8"))
        return ok({
            "content": text(f"已写入 {size} 字节到 {target}"),
            "structuredContent": {"path": str(target), "bytes": size},
        })

    if name == "divide":
        a = arguments.get("a")
        b = arguments.get("b")
        if not is_number(a) or not is_number(b):
            return tool_error("divide 需要数字参数 a 和 b")
        if b == 0:
            return tool_error("division by zero")
        return ok({"content": text(f"{a} / {b} = {a / b}")})

    return tool_error(f"unknown tool: {name}")


def jsonrpc_result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def jsonrpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


@app.get("/health")
def health() -> Any:
    return jsonify({"ok": True, "server": SERVER_NAME, "version": SERVER_VERSION})


@app.post("/mcp")
def mcp_endpoint() -> Any:
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify(jsonrpc_error(None, -32700, "Parse error")), 400

    method = payload.get("method")
    request_id = payload.get("id")

    # 通知（notifications/initialized、notifications/cancelled 等）
    if request_id is None:
        return "", 202

    if method == "initialize":
        return jsonify(jsonrpc_result(request_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": "Rotom 测试服务器：echo / add / python_env / write_temp_file / divide",
        }))

    if method == "ping":
        return jsonify(jsonrpc_result(request_id, {}))

    if method == "tools/list":
        return jsonify(jsonrpc_result(request_id, {"tools": TOOLS}))

    if method == "tools/call":
        params = payload.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}

        if not isinstance(arguments, dict):
            return jsonify(jsonrpc_error(request_id, -32602, "arguments must be an object"))

        return jsonify(jsonrpc_result(request_id, call_tool(str(name), arguments)))

    return jsonify(jsonrpc_error(request_id, -32601, f"Method not found: {method}"))


if __name__ == "__main__":
    port = int(os.environ.get("MCP_PORT", "5000"))
    print(
        f"[{SERVER_NAME}] listening on http://127.0.0.1:{port}/mcp",
        flush=True,
    )
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
