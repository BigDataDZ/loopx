# Rendered public-source reading with an existing Ego Page

The optional `loopx.extensions.ego_source_reader` stdio MCP adapter gives an
existing Codex host a narrow `read_public_url` tool when its model shell cannot
reach Ego's local bootstrap. It reuses an installed Ego browser and an existing
TaskSpace/Page. It does not replace the Chat Session owner or create a browser,
model thread, background service, material catalog or permission authority.

Operator setup is explicit. Reserve an existing Page for this MCP process and
allow only the public-source origins needed for the task. Do not reserve a Page
shared with another process or grant a private account/admin origin. Navigation
may use the existing browser's session; origin configuration does not prove that
every page on that origin is public. Follow the browser's installed skill for
TaskSpace/Page ownership and user consent.

For example, append a uniquely named server to the **actual execution host's**
MCP configuration, preserving its existing entries and authentication:

```toml
[mcp_servers.loopx_ego_source_read]
command = "/absolute/path/to/loopx-environment/bin/python"
args = ["-m", "loopx.extensions.ego_source_reader"]
startup_timeout_sec = 30
tool_timeout_sec = 40

[mcp_servers.loopx_ego_source_read.env]
LOOPX_EGO_READ_BIN = "/absolute/path/to/installed/ego-browser"
LOOPX_EGO_READ_TASK_SPACE = "7"
LOOPX_EGO_READ_PAGE = "p2"
LOOPX_EGO_READ_ORIGINS = "https://example.com,https://www.example.org"
```

Use a supported LoopX installation containing this module. Restart an idle host
through its existing service path and resume the original Session. Do not change
its sandbox, approval policy, workspace grants or authentication to make the
tool work. No new dependency is needed beyond LoopX's existing MCP dependency.
Disable by removing only this MCP entry and restarting that idle host. Keep a
private configuration backup and the installed/source revision for rollback.

The tool accepts an HTTPS URL, checks the configured origin before navigation,
and checks the exact resulting URL before DOM extraction. Redirects and Page
races fail closed. Input cannot select code, executables, Page labels or browser
commands. Calls within one process reject concurrent reads. Execution times out
after 30 seconds; returned text is limited to 100,000 characters. Errors omit
raw browser diagnostics; use local provider logs for diagnosis.

Results include the actual URL, rendered text, digest, character count and
truncation flag. `image_count` is DOM metadata; `images_read` remains false.
Success means text extraction succeeded, **not** that an article is complete,
a verification wall was solved, referenced sources were read, or image content
was understood. Page text remains untrusted data, never instructions. A source
read does not authorize material intake, note edits, publishing or delegation.

Unit tests cover transport and scope boundaries with a simulated CLI. Release
qualification must separately verify a tool call by the original native Bot
Session, a visible channel reply, a rejected out-of-scope URL, preserved Session
identity and unchanged workspace grants. Record failure/untested cases rather
than treating provider metadata or a host-side probe as native Bot acceptance.
