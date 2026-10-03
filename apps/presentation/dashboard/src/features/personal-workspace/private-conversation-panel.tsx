import {useEffect, useState} from "react";
import {connectPrivateConversation, disconnectPrivateConversation, fetchPrivateConversations,
  fetchChatProjects, fetchChatCapabilities, fetchLarkApps, type PrivateConversation,
  type ChatProject, type LarkApp} from "../../data/chat";
import {useWorkspaceI18n} from "./i18n";
import "./project-conversation.css";

export function PrivateConversationPanel() {
  const {locale} = useWorkspaceI18n();
  const zh = locale === "zh-CN";
  const [apps, setApps] = useState<LarkApp[]>([]);
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [executors, setExecutors] = useState<string[]>([]);
  const [rows, setRows] = useState<PrivateConversation[]>([]);
  const [revision, setRevision] = useState(0);
  const [app, setApp] = useState("");
  const [project, setProject] = useState("");
  const [executor, setExecutor] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const state = await fetchPrivateConversations();
    setRows(state.connections); setRevision(state.revision);
  }
  useEffect(() => {
    let active = true;
    Promise.all([fetchLarkApps(), fetchChatProjects(), fetchChatCapabilities(), fetchPrivateConversations()])
      .then(([apps, projects, capabilities, state]) => {
        if (!active) return;
        setApps(apps.filter(app => app.ready && app.app_ref !== "default"));
        setProjects(projects.projects);
        const choices = (capabilities.adapters ?? []).filter(row => row.available).map(row => row.agent_id);
        setExecutors(choices); setExecutor(choices.includes("codex") ? "codex" : choices[0] ?? "");
        if (projects.projects.length === 1) setProject(projects.projects[0].project_ref);
        setRows(state.connections); setRevision(state.revision);
      }).catch(error => {if (active) setError(String(error));});
    const timer = setInterval(() => {fetchPrivateConversations().then(state => {
      if (active) {setRows(state.connections); setRevision(state.revision);}
    }).catch(() => {});}, 5000);
    return () => {active = false; clearInterval(timer);};
  }, []);

  function listenerLabel(state: string) {
    const labels: Record<string, [string, string]> = {starting: ["启动中", "Starting"], listening: ["实时连接就绪", "Live connection ready"],
      standby: ["等待已有监听服务", "Waiting for the existing listener"], retrying: ["重连中", "Reconnecting"],
      stopped: ["已停止", "Stopped"], inactive: ["配置未启用", "Inactive"]};
    return labels[state]?.[zh ? 0 : 1] ?? (zh ? "连接尚未确认" : "Connection unconfirmed");
  }

  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try {await operation(); await refresh();} catch (error) {setError(String(error));}
    finally {setBusy(false);}
  }
  return <section className="personal-detail-card personal-project-conversation" aria-label={zh ? "本人飞书私聊" : "Owner private Chat"}>
    <h3>{zh ? "本人私聊 · 项目对话" : "Owner private Chat · Project conversation"}</h3>
    <p>{zh ? "每个 App 单独核验登录本人，只读讨论所选工作区。普通私聊不会创建 Goal。" : "Verify the logged-in owner independently for each App. Discuss the selected workspace with a read grant; ordinary private Chat creates no Goal."}</p>
    {rows.map(row => <article key={row.binding_id}>
      <strong>{row.app_ref} · {row.context_available ? row.project_title : (zh ? "工作区不可用" : "Workspace unavailable")}</strong>
      <p>{row.executor_endpoint_id} · {zh ? "监听状态" : "Listener"}: {listenerLabel(row.listener_status)}</p>
      <p>{zh ? `待处理或回复：${row.pending_count}` : `Pending execution or reply: ${row.pending_count}`}</p>
      {row.recovery_count > 0 ? <p role="status">{zh ? "存在尚未确认的发送回执。服务会读取原回执恢复；不要重新发送同一任务。检查 App 登录、权限和原会话后刷新状态。" : "A send receipt is unconfirmed. The service reads the original receipt to recover; avoid resending the same task. Check this App login, permissions and original Session, then refresh status."}</p> : null}
      {!row.context_available ? <p role="alert">{zh ? "工作区授权已失效；请恢复原工作区或重新选择。旧会话不会移到其它工作区。" : "The workspace grant is unavailable. Restore the original workspace or select a new one; the old Session will not move."}</p> : null}
      <button disabled={busy} onClick={() => void act(() => disconnectPrivateConversation(row.binding_id, revision))} type="button">{zh ? "解绑" : "Disconnect"}</button>
    </article>)}
    {rows.length === 0 ? <p>{zh ? "尚未连接本人私聊。" : "No owner private Chat connected."}</p> : null}
    <label>App<select aria-label={zh ? "私聊 App" : "Private Chat App"} value={app} disabled={busy} onChange={event => setApp(event.target.value)}>
      <option value="">{zh ? "选择已验证 App" : "Select a verified App"}</option>
      {apps.map(app => <option key={app.app_ref} value={app.app_ref}>{app.label} · {app.app_ref}</option>)}
    </select></label>
    <label>{zh ? "工作区" : "Workspace"}<select aria-label={zh ? "私聊工作区" : "Private Chat workspace"} value={project} disabled={busy} onChange={event => setProject(event.target.value)}>
      <option value="">{zh ? "选择授权工作区" : "Select an authorized workspace"}</option>
      {projects.map(project => <option key={project.project_ref} value={project.project_ref}>{project.title}</option>)}
    </select></label>
    <label>{zh ? "执行器" : "Executor"}<select aria-label={zh ? "私聊执行器" : "Private Chat executor"} value={executor} disabled={busy} onChange={event => setExecutor(event.target.value)}>
      {executors.map(executor => <option key={executor} value={executor}>{executor}</option>)}
    </select></label>
    <div className="personal-detail-actions"><button disabled={busy || !app || !project || !executor} onClick={() => void act(() => connectPrivateConversation(app, project, executor))} type="button">
      {busy ? (zh ? "正在核验" : "Verifying") : (zh ? "连接本人私聊" : "Connect owner private Chat")}</button>
      <button disabled={busy} onClick={() => void act(refresh)} type="button">{zh ? "刷新状态" : "Refresh status"}</button></div>
    <p>{zh ? "从手机发送文字开始；后续消息进入原会话队列。/status 查看状态，/stop 停止当前执行，/new 开启新会话。图片、文件会明确提示暂不支持。" : "Send text from your phone to begin; follow-ups queue in the same Session. /status checks state, /stop stops the current Turn, /new starts a new conversation. Images and files receive an explicit unsupported response."}</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
