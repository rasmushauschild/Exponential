import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person } from './types';
import { shortName } from './types';
import { Avatar } from './WeekPlan';
import { decorate } from './richtext';
import {
  attachLinkPreview, attachmentUrl, cachedPreviews, createChannel, deleteChannel, deleteMessage, dmName, dmOther, editMessage,
  fetchMessages, fetchPreviews, isDm, markRead, messageCache, onChatEvent, openDm, sendMessage, setChannelMembers,
  toggleReaction, updateChannel, uploadChatFile, type Attachment, type Channel, type ChatMessage,
} from './chat';
import { InboxList } from './DetailPanel';
import type { Notification } from './types';
import type { Selection } from './DetailPanel';


interface Props {
  teamId: string;
  me: string;
  people: Person[];
  canModerate: boolean;
  cloud: boolean;
  channels: Channel[];
  activeId: string | null;
  onActive: (id: string | null) => void;
  onRefreshChannels: () => void;
  notifications: Notification[];
  notifUnread: number;
  onOpenItem: (sel: Selection) => void;
  onMarkRead: (ids: string[]) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso: string) => iso.slice(0, 10);
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ChatPage(p: Props) {
  const { teamId, me, people, cloud, channels, activeId, onActive } = p;
  const active = channels.find((c) => c.id === activeId) ?? null;
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState(false);
  // iMessage-style: a conversations screen first; threads and notifications drill in
  const [screen, setScreen] = useState<'list' | 'thread' | 'inbox'>('list');
  const [previews, setPreviews] = useState<Record<string, { body: string; author?: string; at: string }>>(() => cachedPreviews(teamId) ?? {});
  useEffect(() => {
    setPreviews(cachedPreviews(teamId) ?? {}); // instant from cache, then reconcile
    fetchPreviews(teamId, cloud).then(setPreviews).catch(() => {});
  }, [teamId, cloud]);

  // Load (or restore) the open channel's messages; mark it read.
  useEffect(() => {
    if (!active) return;
    let gone = false;
    const cached = messageCache.get(active.id);
    if (cached) setMsgs(cached);
    setOlderDone(false);
    fetchMessages(teamId, active.id, cloud).then((m) => {
      if (gone) return;
      messageCache.set(active.id, m);
      setMsgs(m);
      setOlderDone(m.length < 60);
      markRead(teamId, active.id, me, cloud).then(p.onRefreshChannels);
    }).catch((e) => p.onError(String((e as Error).message ?? e)));
    stickBottom.current = true;
    return () => { gone = true; };
  }, [active?.id, teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live events: append to the open channel (and keep the cache fresh for the rest).
  useEffect(() => onChatEvent((e) => {
    if (e.teamId !== teamId) return;
    if (e.type === 'message') {
      const d = e.message.body || (e.message.attachments?.length ? (e.message.attachments[0].type.startsWith('image/') ? '📷 Image' : e.message.attachments[0].name) : '');
      setPreviews((pv) => ({ ...pv, [e.message.channelId]: { body: d, author: e.message.author, at: e.message.at } }));
      if (e.message.channelId === activeId) {
        setMsgs((ms) => (ms.some((m) => m.id === e.message.id) ? ms : [...ms, e.message]));
        if (document.hasFocus()) markRead(teamId, e.message.channelId, me, cloud).then(p.onRefreshChannels);
      }
    }
    if (e.type === 'message-changed') {
      const patch = (ms: ChatMessage[]) => (e.message.at === '' || e.message.deletedAt
        ? ms.filter((m) => m.id !== e.message.id)
        : ms.map((m) => (m.id === e.message.id ? { ...e.message } : m)));
      if (e.message.channelId === activeId) setMsgs(patch);
    }
  }), [teamId, activeId, cloud, me]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs, activeId]);

  const onScroll = () => {
    const el = listRef.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (!active || !msgs.length) return;
    const el = listRef.current!;
    const keep = el.scrollHeight - el.scrollTop;
    const older = await fetchMessages(teamId, active.id, cloud, msgs[0].at);
    if (older.length < 60) setOlderDone(true);
    const merged = [...older, ...msgs.filter((m) => !older.some((o) => o.id === m.id))];
    messageCache.set(active.id, merged);
    stickBottom.current = false;
    setMsgs(merged);
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - keep; });
  };

  const person = (id?: string) => people.find((x) => x.id === id);

  // group consecutive messages from one author within 5 minutes
  const grouped: { msg: ChatMessage; head: boolean; day?: string }[] = msgs.map((m, i) => {
    const prev = msgs[i - 1];
    const day = !prev || dayKey(prev.at) !== dayKey(m.at) ? fmtDay(m.at) : undefined;
    const head = !!day || !prev || prev.author !== m.author || +new Date(m.at) - +new Date(prev.at) > 5 * 60_000;
    return { msg: m, head, day };
  });

  const regular = channels.filter((c) => !isDm(c));
  const dms = channels.filter(isDm);
  const teammates = people.filter((x) => !x.id.startsWith('pending:'));

  const openDmWith = async (personId: string) => {
    const ch = dms.find((d) => d.name === dmName(me, personId));
    if (ch) { onActive(ch.id); setScreen('thread'); return; }
    try { const id = await openDm(teamId, me, personId, cloud); p.onRefreshChannels(); onActive(id); setScreen('thread'); }
    catch (e) { p.onError(String((e as Error).message ?? e)); }
  };

  const fmtWhen = (at?: string) => {
    if (!at) return '';
    const d = new Date(at);
    if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (Date.now() - +d < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const previewLine = (ch: Channel) => {
    const pv = previews[ch.id];
    if (!pv) return 'No messages yet';
    const who = pv.author === me ? 'You: ' : isDm(ch) ? '' : `${shortName(people.find((x) => x.id === pv.author)?.name ?? '')}: `;
    return who + pv.body;
  };
  const lastNotif = p.notifications.filter((n) => n.to === me).sort((a, b) => b.at.localeCompare(a.at))[0];

  const convoRow = (ch: Channel, icon: React.ReactNode, name: React.ReactNode, onClick: () => void) => (
    <button key={ch.id} className={`convo${ch.unread ? ' unread' : ''}`} onClick={onClick}>
      <span className="convo-dot">{ch.unread > 0 && <span />}</span>
      <span className="convo-icon">{icon}</span>
      <span className="convo-main">
        <span className="convo-name">{name}</span>
        <span className="convo-preview">{previewLine(ch)}</span>
      </span>
      <span className="convo-when">{fmtWhen(previews[ch.id]?.at ?? ch.lastAt)}</span>
    </button>
  );

  return (
    <div className="chat">
      {screen === 'list' && (
        <>
          <div className="side-head">
            <span className="side-title">Messages</span>
            <span className="panel-spacer" />
            <button className="icon-btn" title="Close" onClick={p.onClose}><XGlyph /></button>
          </div>
          <div className="chat-convos">
            {regular.map((ch) => convoRow(ch,
              <span className="convo-hash">{ch.private ? <LockGlyph /> : '#'}</span>,
              ch.name,
              () => { onActive(ch.id); setScreen('thread'); }))}
            {newChannel ? (
              <NewChannelForm people={people} me={me} onClose={() => setNewChannel(false)}
                onCreate={async (name, priv, members) => {
                  try { await createChannel(teamId, me, name, priv, members, cloud); setNewChannel(false); p.onRefreshChannels(); }
                  catch (e) { p.onError(String((e as Error).message ?? e)); }
                }} />
            ) : (
              <button className="convo ghost" onClick={() => setNewChannel(true)}>
                <span className="convo-dot" />
                <span className="convo-icon"><span className="convo-hash">+</span></span>
                <span className="convo-main"><span className="convo-name">New channel</span></span>
              </button>
            )}
            {teammates.map((x) => {
              const ch = dms.find((d) => d.name === dmName(me, x.id));
              const stub: Channel = ch ?? { id: `stub-${x.id}`, name: dmName(me, x.id), private: true, unread: 0 };
              return convoRow(stub,
                <Avatar person={x} size={34} />,
                <>{shortName(x.name)}{x.id === me ? ' (you)' : ''}</>,
                () => openDmWith(x.id));
            })}
            <button className={`convo notifs${p.notifUnread ? ' unread' : ''}`} onClick={() => setScreen('inbox')}>
              <span className="convo-dot">{p.notifUnread > 0 && <span />}</span>
              <span className="convo-icon"><span className="convo-hash"><BellGlyph /></span></span>
              <span className="convo-main">
                <span className="convo-name">Notifications</span>
                <span className="convo-preview">{lastNotif ? lastNotif.text : 'Task and project updates land here'}</span>
              </span>
              <span className="convo-when">{fmtWhen(lastNotif?.at)}</span>
            </button>
          </div>
        </>
      )}

      {screen === 'inbox' && (
        <>
          <div className="side-head">
            <button className="meet-back chat-back" onClick={() => setScreen('list')}><BackGlyph /> Messages</button>
            <span className="side-subtitle">Notifications</span>
            <span className="panel-spacer" />
            <button className="icon-btn" title="Close" onClick={p.onClose}><XGlyph /></button>
          </div>
          <div className="chat-inbox-scroll">
            <InboxList notifications={p.notifications} people={people} me={me} onOpen={p.onOpenItem} onMarkRead={p.onMarkRead} />
          </div>
        </>
      )}

      {screen === 'thread' && active && (
        <div className="chat-main">
          <ThreadHead channel={active} me={me} people={people} canModerate={p.canModerate}
            onBack={() => setScreen('list')}
            onCloseAll={p.onClose}
            onRename={(name) => updateChannel(teamId, active.id, { name }, cloud).catch((e) => p.onError(String(e.message ?? e)))}
            onMembers={(m) => setChannelMembers(teamId, active.id, m, cloud).then(p.onRefreshChannels).catch((e) => p.onError(String(e.message ?? e)))}
            onDelete={() => deleteChannel(teamId, active.id, cloud).then(() => { setScreen('list'); onActive(channels.find((ch) => ch.id !== active.id)?.id ?? null); p.onRefreshChannels(); }).catch((e) => p.onError(String(e.message ?? e)))}
          />
          <div className="chat-list" ref={listRef} onScroll={onScroll}>
            {!olderDone && msgs.length >= 60 && <button className="pill chat-older" onClick={loadOlder}>Load earlier messages</button>}
            {grouped.map(({ msg, head, day }) => (
              <div key={msg.id}>
                {day && <div className="chat-day"><span>{day}</span></div>}
                <MessageRow msg={msg} head={head} author={person(msg.author)} mine={msg.author === me} me={me} people={people} canModerate={p.canModerate} cloud={cloud}
                  onEdit={(body) => editMessage(teamId, msg, body, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onDelete={() => deleteMessage(teamId, msg, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onReact={(emoji) => toggleReaction(teamId, msg, emoji, me, cloud).catch((e) => p.onError(String(e.message ?? e)))}
                  onImage={setLightbox} />
              </div>
            ))}
            {msgs.length === 0 && <div className="chat-empty">No messages yet — say hi 👋</div>}
          </div>
          <Composer key={active.id} channel={active} teamId={teamId} cloud={cloud} onError={p.onError}
            label={isDm(active) ? `Message ${shortName(people.find((x) => x.id === dmOther(active, me))?.name ?? '')}` : `Message #${active.name}`}
            onSend={async (body, atts) => {
              const m = await sendMessage(teamId, active.id, me, body, atts, cloud);
              if (cloud) {
                messageCache.set(active.id, [...(messageCache.get(active.id) ?? []), m]);
                setMsgs((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
                setPreviews((pv) => ({ ...pv, [active.id]: { body: body || 'Attachment', author: me, at: m.at } }));
              }
              attachLinkPreview(teamId, m, cloud).catch(() => {}); // fire and forget
              stickBottom.current = true;
            }} />
        </div>
      )}

      {lightbox && createPortal(
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>, document.body)}
    </div>
  );
}

function LockGlyph() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

function NewChannelForm({ people, me, onCreate, onClose }: { people: Person[]; me: string; onCreate: (name: string, priv: boolean, members: string[]) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [onClose]);
  const create = () => { if (name.trim()) onCreate(name.trim(), priv, [...members]); };
  return (
    <div ref={rootRef} className="chat-newrow-wrap">
      <div className="convo chat-newrow">
        <span className="convo-dot" />
        <span className="convo-icon"><span className="convo-hash">#</span></span>
        <input autoFocus placeholder="channel-name" value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/^dm:+/, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') onClose(); }} />
        <button className={`pill small-pill${priv ? ' toggle active' : ''}`} onClick={() => setPriv(!priv)} title="Only invited people can see a private channel">Private</button>
      </div>
      {priv && (
        <div className="chat-member-pick">
          {people.filter((x) => x.id !== me && !x.id.startsWith('pending:')).map((x) => (
            <button key={x.id} className={`pill${members.has(x.id) ? ' toggle active' : ''}`}
              onClick={() => setMembers((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })}>
              {shortName(x.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadHead({ channel, me, people, canModerate, onBack, onCloseAll, onRename, onMembers, onDelete }: {
  channel: Channel; me: string; people: Person[]; canModerate: boolean;
  onBack: () => void; onCloseAll: () => void;
  onRename: (v: string) => void; onMembers: (m: string[]) => void; onDelete: () => void;
}) {
  const dm = isDm(channel);
  const canManage = !dm && (canModerate || channel.createdBy === me || !channel.createdBy);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.chat-menu')) setMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  const other = dm ? people.find((x) => x.id === dmOther(channel, me)) : undefined;
  return (
    <div className="side-head">
      <button className="meet-back chat-back" onClick={onBack}><BackGlyph /> Messages</button>
      {renaming ? (
        <input className="chat-rename" autoFocus defaultValue={channel.name}
          onBlur={(e) => { const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '-'); if (v && v !== channel.name) onRename(v); setRenaming(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
      ) : (
        <span className="side-subtitle">
          {dm
            ? <>{other && <Avatar person={other} size={22} />}{other ? shortName(other.name) : 'Direct message'}{other?.id === me ? ' (you)' : ''}</>
            : <><span className="chat-hash-big">{channel.private ? <LockGlyph /> : '#'}</span>{channel.name}</>}
        </span>
      )}
      <span className="panel-spacer" />
      {channel.private && !dm && (
        <span className="chat-members" title="Members">
          {(channel.members ?? []).map((id) => people.find((x) => x.id === id)).filter(Boolean).slice(0, 5).map((x) => <Avatar key={x!.id} person={x!} size={20} />)}
        </span>
      )}
      {canManage && (
        <button className="icon-btn" title="Channel options" onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}>⋯</button>
      )}
      <button className="icon-btn" title="Close" onClick={onCloseAll}><XGlyph /></button>
      {menu && createPortal(
        <div className="status-menu chat-menu" style={{ position: 'fixed', top: menu.bottom + 6, right: window.innerWidth - menu.right }}>
          <button onClick={() => { setRenaming(true); setMenu(null); }}>Rename</button>
          {channel.private && <button onClick={() => { setMembersOpen(true); setMenu(null); }}>Members…</button>}
          {channel.name !== 'general' && <button className="danger" onClick={() => { if (confirm(`Delete #${channel.name}? Its messages are removed for everyone.`)) onDelete(); setMenu(null); }}>Delete channel</button>}
        </div>, document.body)}
      {membersOpen && (
        <MembersSheet channel={channel} me={me} people={people} onClose={() => setMembersOpen(false)} onSave={(m) => { onMembers(m); setMembersOpen(false); }} />
      )}
    </div>
  );
}

function MembersSheet({ channel, me, people, onClose, onSave }: { channel: Channel; me: string; people: Person[]; onClose: () => void; onSave: (m: string[]) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set(channel.members ?? [me]));
  return createPortal(
    <div className="sheet-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet chat-members-sheet">
        <div className="sheet-title">Members of #{channel.name}</div>
        <div className="chat-member-pick">
          {people.map((x) => (
            <button key={x.id} className={`pill${sel.has(x.id) ? ' toggle active' : ''}`} disabled={x.id === me}
              onClick={() => setSel((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })}>
              {shortName(x.name)}
            </button>
          ))}
        </div>
        <div className="chat-new-foot">
          <button className="pill" onClick={onClose}>Cancel</button>
          <button className="pill toggle active" onClick={() => onSave([...sel])}>Save</button>
        </div>
      </div>
    </div>, document.body);
}

function MessageRow({ msg, head, author, mine, me, people, canModerate, cloud, onEdit, onDelete, onReact, onImage }: {
  msg: ChatMessage; head: boolean; author?: Person; mine: boolean; me: string; people: Person[]; canModerate: boolean; cloud: boolean;
  onEdit: (body: string) => void; onDelete: () => void; onReact: (emoji: string) => void; onImage: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<DOMRect | null>(null);
  return (
    <div className={`chat-msg${head ? ' head' : ''}`}>
      <span className="chat-gutter">
        {head ? (author ? <Avatar person={author} size={30} /> : <span className="chat-ghost-avatar" />) : <span className="chat-hover-time">{fmtTime(msg.at)}</span>}
      </span>
      <div className="chat-bubble">
        {head && (
          <div className="chat-meta">
            <span className="chat-author">{author ? shortName(author.name) : 'Someone'}</span>
            <span className="chat-time">{fmtTime(msg.at)}</span>
            {msg.editedAt && <span className="chat-time">(edited)</span>}
          </div>
        )}
        {editing ? (
          <textarea className="chat-edit" autoFocus defaultValue={msg.body} rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = (e.target as HTMLTextAreaElement).value.trim(); if (v && v !== msg.body) onEdit(v); setEditing(false); }
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => setEditing(false)} />
        ) : (
          msg.body && <div className="chat-body">{renderChat(msg.body)}{msg.editedAt && !head ? <span className="chat-time"> (edited)</span> : null}</div>
        )}
        {msg.attachments?.map((a, i) => <AttachmentView key={i} att={a} cloud={cloud} onImage={onImage} />)}
        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
          <div className="chat-reacts">
            {Object.entries(msg.reactions).map(([emo, users]) => (
              <ReactChip key={emo} emoji={emo} users={users} me={me} people={people} onClick={() => onReact(emo)} />
            ))}
          </div>
        )}
      </div>
      {!editing && (
        <span className="chat-actions">
          <button title="React" onClick={(e) => setPick((e.currentTarget as HTMLElement).getBoundingClientRect())}><SmileGlyph /></button>
          {mine && <button title="Edit" onClick={() => setEditing(true)}><PencilGlyph /></button>}
          {(mine || canModerate) && <button title="Delete" onClick={onDelete}><CrossGlyph /></button>}
        </span>
      )}
      {pick && <EmojiPop anchor={pick} onPick={(emo) => { onReact(emo); setPick(null); }} onClose={() => setPick(null)} />}
    </div>
  );
}

function SmileGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>;
}

/** Like renderInlineMd, but URLs become real links (opened externally by Electron). */
function renderChat(text: string) {
  const parts = decorate(text);
  if (!parts) return text;
  return parts.map((p, k) => {
    if (typeof p === 'string') return p;
    if ('url' in p) return <a key={k} className="md-linkish" href={p.url.startsWith('http') ? p.url : `https://${p.url}`} target="_blank" rel="noreferrer">{p.label}</a>;
    if (p.style === 'b') return <b key={k}>{p.text}</b>;
    if (p.style === 'i') return <i key={k}>{p.text}</i>;
    if (p.style === 's') return <s key={k}>{p.text}</s>;
    return <b key={k}><i>{p.text}</i></b>;
  });
}

function AttachmentView({ att, cloud, onImage }: { att: Attachment; cloud: boolean; onImage: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(att.path.startsWith('data:') ? att.path : null);
  const isImage = att.type.startsWith('image/');
  if (att.type === 'link/preview') {
    return (
      <a className="link-card" href={att.path} target="_blank" rel="noreferrer">
        <span className="link-card-site">{att.site}</span>
        <span className="link-card-title">{att.name}</span>
        {att.desc && <span className="link-card-desc">{att.desc}</span>}
        {att.img && <img className="link-card-img" src={att.img} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />}
      </a>
    );
  }
  useEffect(() => {
    let gone = false;
    if (!url) attachmentUrl(att, cloud).then((u) => { if (!gone) setUrl(u); }).catch(() => {});
    return () => { gone = true; };
  }, [att.path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isImage) {
    return url
      ? <img className="chat-img" src={url} style={att.w && att.h ? { aspectRatio: `${att.w} / ${att.h}` } : undefined} onClick={() => onImage(url)} alt={att.name} />
      : <div className="chat-img chat-img-loading" style={att.w && att.h ? { aspectRatio: `${att.w} / ${att.h}` } : undefined} />;
  }
  return (
    <a className="chat-file" href={url ?? undefined} download={att.name} target="_blank" rel="noreferrer">
      <FileGlyph />
      <span className="chat-file-name">{att.name}</span>
      <span className="chat-file-size">{fmtSize(att.size)}</span>
    </a>
  );
}

function Composer({ channel, label, teamId, cloud, onSend, onError }: {
  channel: Channel; label: string; teamId: string; cloud: boolean;
  onSend: (body: string, atts: Attachment[] | undefined) => Promise<void>; onError: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(180, ta.scrollHeight)}px`;
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const att = await uploadChatFile(teamId, f, cloud);
        setAtts((a) => [...a, att]);
      } catch (e) { onError(String((e as Error).message ?? e)); }
      setUploading((n) => n - 1);
    }
    taRef.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !atts.length) || sending.current || uploading) return;
    sending.current = true;
    try {
      await onSend(body, atts.length ? atts : undefined);
      setText(''); setAtts([]);
      requestAnimationFrame(grow);
    } catch (e) { onError(String((e as Error).message ?? e)); }
    sending.current = false;
    taRef.current?.focus();
  };

  return (
    <div className={`chat-compose${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
      {(atts.length > 0 || uploading > 0) && (
        <div className="chat-att-row">
          {atts.map((a, i) => (
            <span key={i} className="chat-att-chip" title={a.name}>
              {a.type.startsWith('image/') ? <ThumbChip att={a} cloud={cloud} /> : <FileGlyph />}
              <span className="chat-att-name">{a.name}</span>
              <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {uploading > 0 && <span className="chat-att-chip loading">Uploading…</span>}
        </div>
      )}
      <div className="chat-compose-row">
        <button className="icon-btn" title="Attach a file" onClick={() => fileRef.current?.click()}><ClipGlyph /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
        <span className="chat-field">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={label}
            value={text}
            onChange={(e) => { setText(e.target.value); grow(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[];
              if (imgs.length) { e.preventDefault(); addFiles(imgs); }
            }}
          />
          <button className="chat-return" title="Send (Enter)" disabled={(!text.trim() && !atts.length) || uploading > 0} onClick={send}><ReturnGlyph /></button>
        </span>
      </div>
    </div>
  );
}

function ThumbChip({ att, cloud }: { att: Attachment; cloud: boolean }) {
  const [url, setUrl] = useState<string | null>(att.path.startsWith('data:') ? att.path : null);
  useEffect(() => { let gone = false; if (!url) attachmentUrl(att, cloud).then((u) => !gone && setUrl(u)).catch(() => {}); return () => { gone = true; }; }, [att.path]); // eslint-disable-line react-hooks/exhaustive-deps
  return url ? <img src={url} alt="" /> : <FileGlyph />;
}

/** A reaction chip that shows WHO reacted on hover (avatars + names). */
function ReactChip({ emoji, users, me, people, onClick }: { emoji: string; users: string[]; me: string; people: Person[]; onClick: () => void }) {
  const [hover, setHover] = useState<DOMRect | null>(null);
  return (
    <>
      <button className={users.includes(me) ? 'on' : ''} onClick={onClick}
        onMouseEnter={(e) => setHover((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}>
        {emoji} <span>{users.length}</span>
      </button>
      {hover && createPortal(
        <div className="react-who" style={{ position: 'fixed', left: Math.min(hover.left, window.innerWidth - 190), bottom: window.innerHeight - hover.top + 6 }}>
          <span className="react-who-emoji">{emoji}</span>
          <div className="react-who-names">
            {users.map((u) => {
              const person = people.find((x) => x.id === u);
              return (
                <span key={u} className="react-who-row">
                  {person && <Avatar person={person} size={16} />}
                  {u === me ? 'You' : person ? shortName(person.name) : 'Someone'}
                </span>
              );
            })}
          </div>
        </div>, document.body)}
    </>
  );
}

/** The full emoji picker (searchable, categorized, frequently-used first — Slack-style).
 *  emoji-picker-element is lazy-loaded with locally bundled data, so the main chunk and
 *  offline use are unaffected; it persists your most-used emoji in IndexedDB itself. */
function EmojiPop({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (emoji: string) => void; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ Picker }, data] = await Promise.all([
        import('emoji-picker-element'),
        import('emoji-picker-element-data/en/emojibase/data.json?url'),
      ]);
      if (!alive || !hostRef.current) return;
      const picker = new Picker({ dataSource: (data as { default: string }).default });
      picker.classList.add(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
      picker.addEventListener('emoji-click', (ev) => {
        if (ev.detail.unicode) onPick(ev.detail.unicode);
      });
      hostRef.current.replaceChildren(picker);
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.emoji-pop')) onClose(); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  const W = 324, H = 372;
  const left = Math.max(10, Math.min(anchor.left - W + anchor.width, window.innerWidth - W - 10));
  const top = anchor.bottom + 6 + H <= window.innerHeight - 10 ? anchor.bottom + 6 : Math.max(10, anchor.top - H - 6);
  return createPortal(
    <div ref={hostRef} className="status-menu emoji-pop" style={{ position: 'fixed', left, top, width: W, height: H }} />,
    document.body);
}

function XGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function BackGlyph() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>;
}
function BellGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 0 0 3.4 0" /></svg>;
}
function ReturnGlyph() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5" /><path d="m9 10-4 4 4 4" /></svg>;
}
function PencilGlyph() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>; }
function CrossGlyph() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>; }
function ClipGlyph() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>; }
function FileGlyph() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>; }
