import {useEffect, useRef, useState} from "react";
import {
  acceptChatTurn, closeChatSession, createProjectChatSession, fetchChatProjects,
  fetchChatSession, interruptChatTurn, streamChatTurn,
  type ChatProject, type ChatSessionSummary, type ChatVisibleMessage,
} from "../../data/chat";
import {useWorkspaceI18n} from "./i18n";
import {MarkdownText} from "./markdown";
import "./project-conversation.css";

/** A companion of Core project Chat. Workspace choices are host observations,
 * not client-authored grants, Goals or an alternative conversation store.
 */
export function ProjectConversationPanel() {
  const {locale} = useWorkspaceI18n();
  const zh = locale === "zh-CN";
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [project, setProject] = useState("");
  const [session, setSession] = useState<ChatSessionSummary | null>(null);
  const [messages, setMessages] = useState<ChatVisibleMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const attempt = useRef<{sessionId: string; text: string; requestId: string} | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    fetchChatProjects(abort.signal).then(result => {
      setProjects(result.projects);
      if (result.projects.length === 1) setProject(result.projects[0].project_ref);
    }).catch(error => {if (!abort.signal.aborted) setError(String(error));});
    return () => {mounted.current = false; abort.abort();};
  }, []);

  async function refresh(sessionId: string) {
    const current = await fetchChatSession(sessionId);
    if (!mounted.current) return;
    setSession(current.session);
    setMessages(current.messages);
    setTurnId(current.session.active_turn_id);
  }

  async function open(mode: "new" | "resume_latest") {
    const opened = await createProjectChatSession(project, mode);
    if (mounted.current) {
      attempt.current = null;
      await refresh(opened.session_id);
    }
    return opened.session_id;
  }

  async function send() {
    if (!draft.trim() || !project || busy) return;
    const text = draft;
    setBusy(true); setError("");
    setStatus(zh ? "正在连接执行器" : "Connecting to the executor");
    try {
      const id = session?.session_id ?? await open("resume_latest");
      if (!attempt.current || attempt.current.sessionId !== id || attempt.current.text !== text) {
        attempt.current = {sessionId: id, text, requestId: crypto.randomUUID()};
      }
      const accepted = await acceptChatTurn(id, text, attempt.current.requestId);
      if (mounted.current) {
        setDraft(""); setTurnId(accepted.turn_id);
        setStatus(zh ? "已持久受理，等待结果" : "Durably accepted · awaiting the result");
      }
      let terminal = "";
      await streamChatTurn(accepted.events_url, event => {
        if (["turn.completed", "turn.interrupted", "turn.failed"].includes(event.kind)) terminal = event.kind;
        if (mounted.current && event.kind === "agent.phase") {
          setStatus(String(event.payload.label ?? (zh ? "正在处理" : "Working")));
        }
      });
      attempt.current = null;
      await refresh(id);
      if (mounted.current) setStatus(terminal === "turn.interrupted"
        ? (zh ? "本次请求已停止" : "This request was stopped")
        : terminal === "turn.failed" ? (zh ? "本次执行失败，请查看会话记录。" : "This execution failed; inspect the Session history.") : "");
    } catch (error) {
      if (mounted.current) {
        setError(String(error));
        setStatus(zh ? "请刷新会话查看受理与执行状态；重试保留同一请求标识。" : "Refresh this Session to check admission and execution; retry retains the request identity.");
      }
    } finally {if (mounted.current) setBusy(false);}
  }

  async function changeSession(mode: "new" | "resume_latest") {
    setBusy(true); setError("");
    try {await open(mode);} catch (error) {setError(String(error));}
    finally {setBusy(false);}
  }

  return <section className="personal-detail-card personal-project-conversation">
    <p>{zh ? "只读讨论授权工作区，保留连续上下文。普通聊天不会创建长期 Goal。" : "Discuss an authorized workspace with continuous context and a read grant. Ordinary chat does not create a long-running Goal."}</p>
    <label>{zh ? "工作区" : "Workspace"}
      <select aria-label={zh ? "项目对话工作区" : "Project conversation workspace"} disabled={busy} value={project} onChange={event => {
        setProject(event.target.value); setSession(null); setMessages([]); setTurnId(null); setError(""); setStatus(""); attempt.current = null;
      }}>
        <option value="">{zh ? "选择工作区" : "Choose a workspace"}</option>
        {projects.map(item => <option key={item.project_ref} value={item.project_ref}>{item.title}</option>)}
      </select>
    </label>
    {!projects.length && !error ? <p>{zh ? "此宿主尚未提供可用工作区。" : "This host has no available workspace grants."}</p> : null}
    <div className="personal-detail-actions">
      <button disabled={!project || busy} onClick={() => void changeSession("resume_latest")} type="button">{zh ? "打开或恢复对话" : "Open or resume"}</button>
      <button disabled={!project || busy || !!turnId} onClick={() => void changeSession("new")} type="button">{zh ? "新会话" : "New Session"}</button>
      {session ? <button disabled={busy || !!turnId} onClick={async () => {
        try {await closeChatSession(session.session_id); setSession(null); setMessages([]); setStatus("");}
        catch (error) {setError(String(error));}
      }} type="button">{zh ? "关闭当前会话" : "Close this Session"}</button> : null}
    </div>
    <div className="personal-project-messages" aria-label={zh ? "项目对话记录" : "Project conversation history"}>
      {messages.map(message => <article key={message.message_id}>
        <strong>{message.role === "user" ? (zh ? "你" : "You") : (zh ? "助手" : "Assistant")}</strong>
        <MarkdownText text={message.text} />
      </article>)}
    </div>
    <form onSubmit={event => {event.preventDefault(); void send();}}>
      <label>{zh ? "消息" : "Message"}<textarea aria-label={zh ? "项目对话消息" : "Project conversation message"} disabled={busy} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={!project || busy || !draft.trim()} type="submit">{zh ? "发送" : "Send"}</button>
      {session && turnId ? <button onClick={async () => {
        try {await interruptChatTurn(session.session_id, turnId); await refresh(session.session_id);}
        catch (error) {setError(String(error));}
      }} type="button">{zh ? "停止本次请求" : "Stop this request"}</button> : null}
    </form>
    {session ? <button onClick={() => void refresh(session.session_id).catch(error => setError(String(error)))} type="button">{zh ? "刷新会话状态" : "Refresh Session status"}</button> : null}
    <p aria-live="polite" role="status">{status}</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
