"""Wireclaw MCP 测试服务器：MiniMax H3-Image 多模态产出。

运行：
    pip install flask
    MINIMAX_API_KEY=... python examples/mcp_minimax_image_server.py
    # 或使用本地 key 文件
    MINIMAX_API_KEY_FILE=./apikey-minimax-h3.txt python examples/mcp_minimax_image_server.py
    # 自定义端口
    MCP_PORT=5001 python examples/mcp_minimax_image_server.py

协议：
    JSON-RPC 2.0 over HTTP POST /mcp
    MCP 2025-06-18（简化版 Streamable HTTP，直接返回 application/json）

工具：
    generate_image   生成图片；返回 text + image 内容块
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "wireclaw-minimax-image-mcp"
SERVER_VERSION = "0.1.0"

MINIMAX_BASE_URL = os.environ.get("MINIMAX_BASE_URL", "https://api.minimax.cn").rstrip("/")
MINIMAX_MODEL = os.environ.get("MINIMAX_MODEL", "MiniMax-H3-Image")
MINIMAX_API_KEY_FILE = os.environ.get("MINIMAX_API_KEY_FILE", "apikey-minimax-h3.txt")
MINIMAX_TIMEOUT_SECONDS = int(os.environ.get("MINIMAX_TIMEOUT_SECONDS", "600"))

app = Flask(__name__)


TOOLS: list[dict[str, Any]] = [
    {
        "name": "generate_image",
        "title": "Generate Image",
        "description": "使用 MiniMax H3-Image 生成图片，或基于 1~16 张参考图编辑图片；图片会作为 MCP image 内容返回，由客户端落盘并回传给模型。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "图片生成/编辑提示词"},
                "size": {
                    "type": "string",
                    "description": "可选尺寸，例如 1024x1024；不传时使用 1K 面积",
                },
                "references": {
                    "type": "array",
                    "description": "可选参考图，最多 16 张；每项为公网 http(s) 图片 URL 或 data:image/...;base64,... Data URI。",
                    "items": {"type": "string"},
                    "maxItems": 16,
                },
                "seed": {
                    "type": "integer",
                    "description": "可选随机种子；用于复现或固定构图",
                },
                "negative_prompt": {
                    "type": "string",
                    "description": "可选负向提示词，描述不希望出现的元素",
                },
            },
            "required": ["prompt"],
        },
        # Wireclaw 扩展：该工具生成耗时较长，建议 Session 使用 600s 超时
        "adviceTimeout": 600_000,
        # 非只读工具，Wireclaw 的 approval=auto 会要求审批
        "annotations": {"readOnlyHint": False},
    },
]


def read_api_key() -> str:
    key = os.environ.get("MINIMAX_API_KEY", "").strip()
    if key:
        return key

    path = Path(MINIMAX_API_KEY_FILE)
    raw = path.read_text(encoding="utf-8").replace("\ufeff", "").strip()
    assignment = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("MINIMAX_API_KEY="):
            assignment = line.split("=", 1)[1].strip()
            break
    key = (assignment if assignment is not None else raw).strip().strip("\"'")
    if not key:
        raise RuntimeError(f"MiniMax API key is empty: {path}")
    return key


def generate_image(
    prompt: str,
    size: str | None,
    references: list[str] | None = None,
    seed: int | None = None,
    negative_prompt: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": MINIMAX_MODEL,
        "prompt": prompt,
        "n": 1,
        "output_format": "png",
        "response_format": "b64_json",
        "stream": False,
    }
    if size:
        body["size"] = size
    else:
        body["area"] = "1K"
    if seed is not None:
        body["seed"] = seed
    if negative_prompt is not None:
        body["negative_prompt"] = negative_prompt

    endpoint = "/v1/images/generations"
    if references:
        endpoint = "/v1/images/edits"
        body["images"] = [{"image_url": reference} for reference in references]

    request_data = json.dumps(body).encode("utf-8")
    http_request = urllib.request.Request(
        f"{MINIMAX_BASE_URL}{endpoint}",
        data=request_data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {read_api_key()}",
        },
    )

    try:
        with urllib.request.urlopen(http_request, timeout=MINIMAX_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"MiniMax HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"MiniMax request failed: {error.reason}") from error

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        raise RuntimeError("MiniMax returned no image data")

    item = data[0] if isinstance(data[0], dict) else {}
    b64_json = item.get("b64_json")
    if not isinstance(b64_json, str) or not b64_json:
        image_url = item.get("url")
        if not isinstance(image_url, str) or not image_url:
            raise RuntimeError("MiniMax returned neither b64_json nor url")
        with urllib.request.urlopen(image_url, timeout=MINIMAX_TIMEOUT_SECONDS) as response:
            image_bytes = response.read()
            content_type = response.headers.get_content_type()
        b64_json = base64.b64encode(image_bytes).decode("ascii")
    else:
        content_type = "image/png"

    return {
        "content": [
            {"type": "text", "text": f"Generated image with {MINIMAX_MODEL}."},
            {"type": "image", "data": b64_json, "mimeType": content_type},
        ],
        "structuredContent": {
            "model": MINIMAX_MODEL,
            "mimeType": content_type,
        },
    }


def tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name != "generate_image":
        return tool_error(f"unknown tool: {name}")

    prompt = arguments.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return tool_error("generate_image requires a non-empty prompt")

    size = arguments.get("size")
    if size is not None and not isinstance(size, str):
        return tool_error("size must be a string")

    references = arguments.get("references")
    if references is not None:
        if not isinstance(references, list) or not references:
            return tool_error("references must be a non-empty array")
        if len(references) > 16:
            return tool_error("references supports at most 16 images")
        if any(not isinstance(item, str) or not item for item in references):
            return tool_error("each reference must be a non-empty string")

    seed = arguments.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
        return tool_error("seed must be an integer")

    negative_prompt = arguments.get("negative_prompt")
    if negative_prompt is not None and not isinstance(negative_prompt, str):
        return tool_error("negative_prompt must be a string")

    try:
        return generate_image(prompt.strip(), size, references, seed, negative_prompt)
    except Exception as error:  # 简化示例：把生成失败映射为工具错误
        return tool_error(str(error))


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

    if request_id is None:
        return "", 202

    if method == "initialize":
        return jsonify(jsonrpc_result(request_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": "Wireclaw MiniMax H3-Image 测试服务器：generate_image",
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
    port = int(os.environ.get("MCP_PORT", "5001"))
    print(
        f"[{SERVER_NAME}] listening on http://127.0.0.1:{port}/mcp",
        flush=True,
    )
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
