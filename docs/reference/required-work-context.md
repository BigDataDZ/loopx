# Required work context

Heartbeat and Turn consume the same pre-work read obligations from
`interaction_contract.agent_channel.required_reads`. The typed interaction
owner adds complete registered Goal intent, enabled canonical acceptance, and
the effective selected Todo after delivery admission. Capability hooks retain
their exact commands, ordering and identities. TurnEnvelope projects and signs
these facts; it does not select work or invent a separate read list.

For an exact Todo, the existing command now returns one complete record:

```sh
loopx --format json todo list --goal-id example-goal --todo-id todo_work
```

Read `todo.text` plus identity, status/claim, `relations`, source and canonical
`authority_read` revision. The former `todos`, `agent_todos` and `user_todos`
views are removed from exact responses. There is no opt-in compatibility flag.
Inventory reads without `--todo-id` retain list views; `--thin` belongs to those
bounded lists and is rejected with an exact identity. A full requirement tail
must never be replaced by a summary. Markdown also renders the original once.

Missing or filtered work returns `matched=false`, `todo=null`, `not_found=true`.
Ambiguous records and source failures fail visibly, without stale-display
fallback. Blocked, completed and archived records remain read-only observations.
An exact read grants no claim, lease, execution, publication or quota authority.
Changed requirements require fresh admission under the original owner.

The existing Python reader retains source resolution and filtering. It passes
one source row to the registered TypeScript `todo.context.page` projection,
without transporting duplicate body or role-summary views. Chat manager detail,
Explore writeback and monitor settlement use the exact record rather than a
removed list alias. No second authority store or selection rule is introduced.

This changes default exact CLI/API output and admitted Heartbeat/Turn read
obligations. Regenerate saved expanded heartbeat prompts after installing the
change. Bootstrap prompts load installed rules on the next wake. TurnEnvelope
transport remains an explicit projection choice; this change alone neither
upgrades installed automations nor proves model adoption or token/latency gains.
To roll back, install the prior revision and regenerate prompts; changing a
transport flag does not restore the old exact Todo schema.

## 中文

Heartbeat 和 Turn 从同一类型化 owner 获得必读项：先保留 capability hook，
再读取完整 Goal、已启用的验收和当前工作。短包保留命令、执行顺序和 hook 身份，
不独立推断读取规则。CLI channel 不再重复 agent 的必读列表。

`todo list --todo-id …` 默认只返回一份完整 `todo.text`，保留来源、修订、身份、
状态和关系。精确响应移除列表及角色视图，不保留兼容开关；`--thin` 只用于概览。
缺失/过滤返回未匹配，歧义/来源故障报错，不退回旧摘要。读到记录不等于获得执行
权限；阻塞、已完成、归档记录仍只是观察。需求改变须重新准入。

安装后重新生成旧展开式 heartbeat 提示；此 PR 不热更新 runtime/automation，
也不证明模型已采用或获得质量收益。回滚需恢复旧版本并重新生成提示。
