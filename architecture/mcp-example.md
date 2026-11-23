# Python + Flask MCP Test Server

## 最小 MCP Server

`examples/mcp_server.py` 是一个最小 MCP Server，用于验证跨语言、跨进程调用。

```bash
pip install flask
python examples/mcp_server.py
## 自定义端口
MCP_PORT=5001 python examples/mcp_server.py
```

提供 5 个工具：

| 工具 | 类型 | 说明 |
|---|---|---|
| `echo` | 只读 | 回显文本 |
| `add` | 只读 | 数字相加 |
| `python_env` | 只读 | 返回 Python 版本 / 平台 / PID |
| `write_temp_file` | 破坏性 | 写入系统临时目录（触发审批） |
| `divide` | 只读 | 除零时返回 `isError` |

手动验证（PowerShell）：

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5000/mcp `
  -ContentType 'application/json' -Body $body
```

或启动 CLI 后：

```
> /tools
> 调用 mcp__python_env 并告诉我结果
```


